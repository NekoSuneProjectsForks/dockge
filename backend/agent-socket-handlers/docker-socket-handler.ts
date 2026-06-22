import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, fileExists, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { requireAdmin, requireStackAccess } from "../auth";
import { promises as fsAsync, createWriteStream } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import archiver from "archiver";
import extract from "extract-zip";

// Chunk size for streamed node-to-node transfers. Small enough to stay well
// under socket.io's maxHttpBufferSize even after base64 expansion, large
// enough to keep the number of round-trips reasonable for multi-GB stacks.
const TRANSFER_CHUNK_SIZE = 16 * 1024 * 1024;

interface TransferState {
    type: "export" | "import";
    zipPath: string;
    stackName: string;
    size: number;
    received?: number;
    writeStream?: ReturnType<typeof createWriteStream>;
    createdAt: number;
}

// Active transfers keyed by a client-generated transfer id. Per-node (each
// Dockge instance keeps its own map for the side of the transfer it handles).
const activeTransfers = new Map<string, TransferState>();

function transferTmpDir() {
    return path.join(os.tmpdir(), "dockge-transfers");
}

// Best-effort cleanup of transfers that were abandoned (browser closed, etc.).
function reapStaleTransfers() {
    const now = Date.now();
    for (const [ id, state ] of activeTransfers) {
        if (now - state.createdAt > 6 * 60 * 60 * 1000) {
            try {
                state.writeStream?.destroy();
            } catch (e) {
                // ignore
            }
            fsAsync.rm(state.zipPath, { force: true }).catch(() => {});
            activeTransfers.delete(id);
        }
    }
}

/**
 * Stream a directory into a zip file on disk, reporting progress.
 * @param sourceDir Directory to archive
 * @param zipPath Destination zip file path
 * @param onProgress Called with a 0-100 percentage as the archive is written
 */
function zipDirectory(sourceDir: string, zipPath: string, onProgress: (percent: number) => void): Promise<number> {
    return new Promise((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 6 } });

        output.on("close", () => resolve(archive.pointer()));
        output.on("error", reject);
        archive.on("error", reject);
        archive.on("warning", (err) => {
            if (err.code !== "ENOENT") {
                reject(err);
            }
        });
        archive.on("progress", (data) => {
            const total = data.fs.totalBytes || 0;
            const processed = data.fs.processedBytes || 0;
            if (total > 0) {
                onProgress(Math.min(99, Math.floor((processed / total) * 100)));
            }
        });

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}
import { buildAppInstall } from "../app-catalog";
import { getComposeTerminalName } from "../../common/util-common";
import { Terminal } from "../terminal";
import { getSystemSpecs } from "../system-specs";
import { spawnDocker } from "../docker-cli";

export class DockerSocketHandler extends AgentSocketHandler {
    private static runningBulkUpdateEndpoints = new Set<string>();

    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Do not call super.create()

        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) === "string" && !Boolean(isAdd)) {
                    await requireStackAccess(socket, name, socket.endpoint);
                }
                const stack = await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                await stack.deploy(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                }, callback);
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) === "string" && !Boolean(isAdd)) {
                    await requireStackAccess(socket, name, socket.endpoint);
                }
                await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("installAppTemplate", async (appID : unknown, requestData : unknown, callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);

                if (typeof(appID) !== "string" || typeof(requestData) !== "object" || requestData === null) {
                    throw new ValidationError("Invalid app install request");
                }

                const install = buildAppInstall(appID, requestData as Record<string, string>);
                const stack = new Stack(server, install.stackName, install.composeYAML, install.composeENV, false);
                await stack.save(true);
                for (const file of install.extraFiles || []) {
                    const filePath = path.join(stack.path, file.path);
                    await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
                    await fsAsync.writeFile(filePath, file.content, "utf-8");
                }
                await stack.deploy(socket);
                server.sendStackList();

                callbackResult({
                    ok: true,
                    msg: `Installed ${install.app.name}.`,
                    stackName: install.stackName,
                }, callback);

                stack.joinCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("deleteStack", async (name : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) !== "string") {
                    throw new ValidationError("Name must be a string");
                }
                await requireStackAccess(socket, name, socket.endpoint);
                const stack = await Stack.getStack(server, name);

                try {
                    await stack.delete(socket);
                } catch (e) {
                    server.sendStackList();
                    throw e;
                }

                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // ===== Node-to-node stack transfer (streamed + chunked) =====
        // The stack is zipped to a temp file on the source, streamed in chunks
        // (so multi-GB stacks never exceed the socket buffer or RAM), then
        // stream-extracted and deployed on the target. Progress for each stage
        // (zip / transfer / unzip / deploy) is pushed via "transferProgress".

        // Source: zip the stack to a temp file and report how to fetch it.
        agentSocket.on("transferExportBegin", async (stackName : unknown, transferId : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(transferId) !== "string") {
                    throw new ValidationError("Invalid transfer request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);
                if (!stack.isManagedByDockge) {
                    throw new ValidationError("Only Dockge-managed stacks can be transferred.");
                }

                reapStaleTransfers();
                await fsAsync.mkdir(transferTmpDir(), { recursive: true });
                const zipPath = path.join(transferTmpDir(), `${transferId}.zip`);

                socket.emitAgent("transferProgress", { transferId, stage: "zip", percent: 0 });
                const size = await zipDirectory(stack.fullPath, zipPath, (percent) => {
                    socket.emitAgent("transferProgress", { transferId, stage: "zip", percent });
                });
                socket.emitAgent("transferProgress", { transferId, stage: "zip", percent: 100 });

                const totalChunks = Math.max(1, Math.ceil(size / TRANSFER_CHUNK_SIZE));
                activeTransfers.set(transferId, {
                    type: "export",
                    zipPath,
                    stackName,
                    size,
                    createdAt: Date.now(),
                });

                callbackResult({
                    ok: true,
                    transferId,
                    size,
                    totalChunks,
                    chunkSize: TRANSFER_CHUNK_SIZE,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Source: return one chunk of the zip as base64.
        agentSocket.on("transferExportChunk", async (transferId : unknown, chunkIndex : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(transferId) !== "string" || typeof(chunkIndex) !== "number") {
                    throw new ValidationError("Invalid transfer chunk request");
                }
                const state = activeTransfers.get(transferId);
                if (!state || state.type !== "export") {
                    throw new ValidationError("Transfer not found or expired.");
                }

                const fh = await fsAsync.open(state.zipPath, "r");
                try {
                    const buffer = Buffer.alloc(TRANSFER_CHUNK_SIZE);
                    const { bytesRead } = await fh.read(buffer, 0, TRANSFER_CHUNK_SIZE, chunkIndex * TRANSFER_CHUNK_SIZE);
                    callbackResult({
                        ok: true,
                        dataBase64: buffer.subarray(0, bytesRead).toString("base64"),
                        bytesRead,
                    }, callback);
                } finally {
                    await fh.close();
                }
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Source: delete the temp zip once the transfer is done (or aborted).
        agentSocket.on("transferExportEnd", async (transferId : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(transferId) !== "string") {
                    throw new ValidationError("Invalid transfer request");
                }
                const state = activeTransfers.get(transferId);
                if (state) {
                    await fsAsync.rm(state.zipPath, { force: true });
                    activeTransfers.delete(transferId);
                }
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Target: prepare to receive a streamed zip.
        agentSocket.on("transferImportBegin", async (stackName : unknown, size : unknown, transferId : unknown, callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);

                if (typeof(stackName) !== "string" || typeof(transferId) !== "string") {
                    throw new ValidationError("Invalid import request");
                }
                if (!stackName.match(/^[a-z0-9_-]+$/)) {
                    throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
                }
                const totalSize = Number(size);
                if (!Number.isFinite(totalSize) || totalSize < 0) {
                    throw new ValidationError("Invalid transfer size");
                }

                const targetDir = path.join(server.stacksDir, stackName);
                if (await fileExists(targetDir)) {
                    throw new ValidationError("A stack with this name already exists on the target node.");
                }

                reapStaleTransfers();
                await fsAsync.mkdir(transferTmpDir(), { recursive: true });
                const zipPath = path.join(transferTmpDir(), `${transferId}.zip`);

                activeTransfers.set(transferId, {
                    type: "import",
                    zipPath,
                    stackName,
                    size: totalSize,
                    received: 0,
                    writeStream: createWriteStream(zipPath),
                    createdAt: Date.now(),
                });

                callbackResult({
                    ok: true,
                    transferId,
                    chunkSize: TRANSFER_CHUNK_SIZE,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Target: append a chunk to the temp zip and report transfer progress.
        agentSocket.on("transferImportChunk", async (transferId : unknown, dataBase64 : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(transferId) !== "string" || typeof(dataBase64) !== "string") {
                    throw new ValidationError("Invalid transfer chunk");
                }
                const state = activeTransfers.get(transferId);
                if (!state || state.type !== "import" || !state.writeStream) {
                    throw new ValidationError("Transfer not found or expired.");
                }

                const buffer = Buffer.from(dataBase64, "base64");
                await new Promise<void>((resolve, reject) => {
                    state.writeStream!.write(buffer, (err) => (err ? reject(err) : resolve()));
                });
                state.received = (state.received || 0) + buffer.length;

                const percent = state.size > 0
                    ? Math.min(99, Math.floor((state.received / state.size) * 100))
                    : 0;
                socket.emitAgent("transferProgress", { transferId, stage: "transfer", percent });

                callbackResult({ ok: true, received: state.received }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Target: finalize - extract the zip and optionally deploy.
        agentSocket.on("transferImportEnd", async (transferId : unknown, deploy : unknown, callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);
                if (typeof(transferId) !== "string") {
                    throw new ValidationError("Invalid transfer request");
                }
                const state = activeTransfers.get(transferId);
                if (!state || state.type !== "import" || !state.writeStream) {
                    throw new ValidationError("Transfer not found or expired.");
                }

                // Flush and close the temp zip file.
                await new Promise<void>((resolve) => state.writeStream!.end(() => resolve()));

                const targetDir = path.resolve(path.join(server.stacksDir, state.stackName));

                try {
                    // extract-zip streams entries and rejects path-traversal
                    // ("zip slip") entries, so extraction stays inside targetDir.
                    let processed = 0;
                    await extract(state.zipPath, {
                        dir: targetDir,
                        onEntry: (entry, zipfile) => {
                            processed += 1;
                            const total = zipfile.entryCount || 0;
                            const percent = total > 0 ? Math.min(99, Math.floor((processed / total) * 100)) : 0;
                            socket.emitAgent("transferProgress", { transferId, stage: "unzip", percent });
                        },
                    });
                    socket.emitAgent("transferProgress", { transferId, stage: "unzip", percent: 100 });
                } catch (extractError) {
                    await fsAsync.rm(targetDir, { recursive: true, force: true });
                    throw extractError;
                } finally {
                    await fsAsync.rm(state.zipPath, { force: true });
                    activeTransfers.delete(transferId);
                }

                server.sendStackList();

                if (Boolean(deploy)) {
                    socket.emitAgent("transferProgress", { transferId, stage: "deploy", percent: 0 });
                    try {
                        const stack = await Stack.getStack(server, state.stackName);
                        await stack.deploy(socket);
                        server.sendStackList();
                        stack.joinCombinedTerminal(socket);
                    } catch (deployError) {
                        // Roll back so a failed transfer leaves no duplicate.
                        await fsAsync.rm(targetDir, { recursive: true, force: true });
                        server.sendStackList();
                        throw deployError;
                    }
                }

                socket.emitAgent("transferProgress", { transferId, stage: "done", percent: 100 });
                callbackResult({
                    ok: true,
                    msg: "Stack imported.",
                    stackName: state.stackName,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);

                if (stack.isManagedByDockge) {
                    stack.joinCombinedTerminal(socket);
                }

                callbackResult({
                    ok: true,
                    stack: await stack.toJSON(socket.endpoint),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // requestStackList
        agentSocket.on("requestStackList", async (callback) => {
            try {
                checkLogin(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("cancelStackOperation", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                await requireStackAccess(socket, stackName, socket.endpoint);

                const terminalName = getComposeTerminalName(socket.endpoint, stackName);
                const cancelled = Terminal.cancel(terminalName);

                if (!cancelled) {
                    throw new ValidationError("No running stack operation found.");
                }

                callbackResult({
                    ok: true,
                    msg: "Operation cancelled.",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // startStack
        agentSocket.on("startStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);
                await stack.start(socket);
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                server.sendStackList();

                stack.joinCombinedTerminal(socket);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // stopStack
        agentSocket.on("stopStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);
                await stack.stop(socket);
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restartStack
        agentSocket.on("restartStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);
                await stack.restart(socket);
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // updateStack
        agentSocket.on("updateStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);
                await stack.update(socket);
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackServiceAction", async (stackName : unknown, serviceName : unknown, action : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string" || typeof(action) !== "string") {
                    throw new ValidationError("Invalid service action");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const allowedActions = new Set([ "start", "stop", "restart", "kill" ]);
                if (!allowedActions.has(action)) {
                    throw new ValidationError("Unsupported service action");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.serviceAction(socket, serviceName, action as "start" | "stop" | "restart" | "kill");
                server.sendStackList();

                callbackResult({
                    ok: true,
                    msg: `Service ${action} completed.`,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("updateAllStacks", async (requestData : unknown, callback) => {
            const endpointKey = socket.endpoint || "";
            try {
                checkLogin(socket);
                await requireAdmin(socket);

                let forceRestart = false;
                if (typeof requestData === "function") {
                    callback = requestData;
                } else if (typeof requestData === "object" && requestData !== null) {
                    forceRestart = Boolean((requestData as Record<string, unknown>).forceRestart);
                }

                if (DockerSocketHandler.runningBulkUpdateEndpoints.has(endpointKey)) {
                    throw new ValidationError("Update All is already running on this node.");
                }

                DockerSocketHandler.runningBulkUpdateEndpoints.add(endpointKey);

                const stackList = await Stack.getStackList(server, true);
                const managedStacks = Array.from(stackList.values()).filter((stack) => stack.isEligibleForBulkUpdate);
                const results: Array<{
                    stackName: string,
                    ok: boolean,
                    updatesFound: boolean,
                    restarted: boolean,
                    skippedRestart?: boolean,
                    error?: string,
                    pullSummary?: string,
                    state?: string,
                }> = [];
                let updated = 0;
                let failed = 0;
                let updatesFoundCount = 0;
                let restartedCount = 0;
                let processed = 0;

                if (managedStacks.length === 0) {
                    const emptyResult = {
                        ok: true,
                        running: false,
                        total: 0,
                        processed: 0,
                        updated: 0,
                        failed: 0,
                        updatesFound: 0,
                        restarted: 0,
                        currentStackName: "",
                        results,
                        msg: "No Dockge-managed stacks found on this node.",
                        finishedAt: Date.now(),
                    };
                    socket.emitAgent("updateAllStacksProgress", emptyResult);
                    callbackResult(emptyResult, callback);
                    return;
                }

                socket.emitAgent("updateAllStacksProgress", {
                    running: true,
                    total: managedStacks.length,
                    processed,
                    updated,
                    failed,
                    updatesFound: updatesFoundCount,
                    restarted: restartedCount,
                    currentStackName: "",
                    results,
                });

                for (const stack of managedStacks) {
                    socket.emitAgent("updateAllStacksProgress", {
                        running: true,
                        total: managedStacks.length,
                        processed,
                        updated,
                        failed,
                        updatesFound: updatesFoundCount,
                        restarted: restartedCount,
                        currentStackName: stack.name,
                        results,
                    });

                    try {
                        const result = await stack.updateForBulk(forceRestart);
                        updated += 1;
                        if (result.updatesFound) {
                            updatesFoundCount += 1;
                        }
                        if (result.restarted) {
                            restartedCount += 1;
                        }
                        results.push({
                            ...result,
                            state: result.updatesFound ? (result.restarted ? "updated_and_restarted" : "updated") : (result.restarted ? "restarted" : "no_updates"),
                        });
                    } catch (e) {
                        failed += 1;
                        results.push({
                            stackName: stack.name,
                            ok: false,
                            updatesFound: false,
                            restarted: false,
                            state: "failed",
                            error: e instanceof Error ? e.message : "Unknown error",
                        });
                    }

                    processed += 1;
                    socket.emitAgent("updateAllStacksProgress", {
                        running: true,
                        total: managedStacks.length,
                        processed,
                        updated,
                        failed,
                        updatesFound: updatesFoundCount,
                        restarted: restartedCount,
                        currentStackName: processed < managedStacks.length ? managedStacks[processed].name : "",
                        results,
                    });
                }

                server.sendStackList();
                const finalMsg = failed > 0
                    ? `Processed ${updated} stack(s). ${updatesFoundCount} had updates, ${restartedCount} restarted, ${failed} failed.`
                    : updatesFoundCount === 0
                        ? `No more updates found. Checked ${processed} Dockge-managed stack(s).`
                        : `Processed ${updated} stack(s). ${updatesFoundCount} had updates, ${restartedCount} restarted.`;

                const finalResult = {
                    ok: failed === 0,
                    running: false,
                    total: managedStacks.length,
                    processed,
                    updated,
                    failed,
                    updatesFound: updatesFoundCount,
                    restarted: restartedCount,
                    currentStackName: "",
                    results,
                    msg: finalMsg,
                    finishedAt: Date.now(),
                };
                socket.emitAgent("updateAllStacksProgress", finalResult);
                callbackResult(finalResult, callback);
            } catch (e) {
                socket.emitAgent("updateAllStacksProgress", {
                    ok: false,
                    running: false,
                    total: 0,
                    processed: 0,
                    updated: 0,
                    failed: 0,
                    updatesFound: 0,
                    restarted: 0,
                    currentStackName: "",
                    results: [],
                    msg: e instanceof Error ? e.message : "Update All failed.",
                    finishedAt: Date.now(),
                });
                callbackError(e, callback);
            } finally {
                DockerSocketHandler.runningBulkUpdateEndpoints.delete(endpointKey);
            }
        });

        // down stack
        agentSocket.on("downStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);
                await stack.down(socket);
                callbackResult({
                    ok: true,
                    msg: "Downed",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Services status
        agentSocket.on("serviceStatusList", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName, true);
                const serviceStatusList = Object.fromEntries(await stack.getServiceStatusList());
                callbackResult({
                    ok: true,
                    serviceStatusList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackResourceStats", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName, true);
                callbackResult({
                    ok: true,
                    stats: Object.fromEntries(await stack.getResourceStatsList()),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackServiceContainers", async (stackName : unknown, serviceName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string") {
                    throw new ValidationError("Invalid service request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName, true);
                callbackResult({
                    ok: true,
                    containers: await stack.getServiceContainers(serviceName),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // getExternalNetworkList
        agentSocket.on("getDockerNetworkList", async (callback) => {
            try {
                checkLogin(socket);
                const dockerNetworkList = await server.getDockerNetworkList();
                callbackResult({
                    ok: true,
                    dockerNetworkList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("systemSpecs", async (callback) => {
            try {
                checkLogin(socket);
                callbackResult({
                    ok: true,
                    specs: await getSystemSpecs(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("dockerImageList", async (callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);
                callbackResult({
                    ok: true,
                    images: await this.getDockerImages(server),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("pruneUnusedImages", async (callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);
                await spawnDocker(server, [ "image", "prune", "-a", "-f" ], undefined, {
                    encoding: "utf-8",
                });
                callbackResult({
                    ok: true,
                    msg: "Unused images removed.",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("removeDockerImage", async (imageID : unknown, callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);
                if (typeof(imageID) !== "string") {
                    throw new ValidationError("Image ID must be a string");
                }
                await spawnDocker(server, [ "image", "rm", imageID ], undefined, {
                    encoding: "utf-8",
                });
                callbackResult({
                    ok: true,
                    msg: "Image removed.",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("dockerContainerList", async (callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);
                const res = await spawnDocker(server, [ "ps", "-a", "--format", "{{json .}}" ], undefined, {
                    encoding: "utf-8",
                });
                const containers = (res.stdout?.toString() || "")
                    .split("\n")
                    .filter((line) => line.trim())
                    .map((line) => JSON.parse(line) as Record<string, string>);
                callbackResult({
                    ok: true,
                    containers,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("dockerContainerAction", async (containerID : unknown, action : unknown, callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);
                if (typeof(containerID) !== "string" || typeof(action) !== "string") {
                    throw new ValidationError("Invalid container action");
                }
                const allowedActions = new Set([ "start", "stop", "restart", "rm" ]);
                if (!allowedActions.has(action)) {
                    throw new ValidationError("Unsupported container action");
                }
                await spawnDocker(server, [ action, containerID ], undefined, {
                    encoding: "utf-8",
                });
                callbackResult({
                    ok: true,
                    msg: "Container action completed.",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackFileList", async (stackName : unknown, relativePath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);
                const stack = await Stack.getStack(server, stackName);
                const targetPath = this.resolveStackFilePath(stack, typeof relativePath === "string" ? relativePath : "");
                const entries = await fsAsync.readdir(targetPath, { withFileTypes: true });
                callbackResult({
                    ok: true,
                    cwd: path.relative(stack.fullPath, targetPath).replace(/\\/g, "/"),
                    files: entries.map((entry) => ({
                        name: entry.name,
                        isDirectory: entry.isDirectory(),
                    })).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackFileRead", async (stackName : unknown, relativePath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(relativePath) !== "string") {
                    throw new ValidationError("Invalid file request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);
                const stack = await Stack.getStack(server, stackName);
                const targetPath = this.resolveStackFilePath(stack, relativePath);
                callbackResult({
                    ok: true,
                    content: await fsAsync.readFile(targetPath, "utf-8"),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackFileWrite", async (stackName : unknown, relativePath : unknown, content : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(relativePath) !== "string" || typeof(content) !== "string") {
                    throw new ValidationError("Invalid file request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);
                const stack = await Stack.getStack(server, stackName);
                const targetPath = this.resolveStackFilePath(stack, relativePath);
                await fsAsync.mkdir(path.dirname(targetPath), { recursive: true });
                await fsAsync.writeFile(targetPath, content, "utf-8");
                callbackResult({
                    ok: true,
                    msg: "Saved",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackFileDelete", async (stackName : unknown, relativePath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(relativePath) !== "string") {
                    throw new ValidationError("Invalid file request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);
                const stack = await Stack.getStack(server, stackName);
                const targetPath = this.resolveStackFilePath(stack, relativePath);
                await fsAsync.rm(targetPath, {
                    recursive: true,
                    force: true
                });
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackFileUpload", async (stackName : unknown, relativePath : unknown, fileName : unknown, contentBase64 : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(relativePath) !== "string" || typeof(fileName) !== "string" || typeof(contentBase64) !== "string") {
                    throw new ValidationError("Invalid upload request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);
                const stack = await Stack.getStack(server, stackName);
                const folderPath = this.resolveStackFilePath(stack, relativePath);
                const filePath = this.resolveStackFilePath(stack, path.posix.join(relativePath.replace(/\\/g, "/"), fileName));
                await fsAsync.mkdir(folderPath, { recursive: true });
                await fsAsync.writeFile(filePath, Buffer.from(contentBase64, "base64"));
                callbackResult({
                    ok: true,
                    msg: "Uploaded",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("stackFileDownload", async (stackName : unknown, relativePath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(relativePath) !== "string") {
                    throw new ValidationError("Invalid download request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);
                const stack = await Stack.getStack(server, stackName);
                const targetPath = this.resolveStackFilePath(stack, relativePath);
                callbackResult({
                    ok: true,
                    fileName: path.basename(targetPath),
                    contentBase64: (await fsAsync.readFile(targetPath)).toString("base64"),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("containerFileList", async (stackName : unknown, serviceName : unknown, containerID : unknown, targetPath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string" || typeof(containerID) !== "string" || typeof(targetPath) !== "string") {
                    throw new ValidationError("Invalid container file request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const containerName = await this.resolveServiceContainer(server, stackName, serviceName, containerID);
                const normalizedPath = this.normalizeContainerPath(targetPath);
                // List entries including hidden files and broken symlinks.
                // `-e` alone skips dangling symlinks, so also check `-L`.
                const script = "target=\"$1\"; if [ ! -d \"$target\" ]; then echo \"__DOCKGE_NOT_DIR__\"; exit 12; fi; cd \"$target\" || exit 13; for entry in .* *; do if [ \"$entry\" = \".\" ] || [ \"$entry\" = \"..\" ]; then continue; fi; if [ ! -e \"$entry\" ] && [ ! -L \"$entry\" ]; then continue; fi; if [ -d \"$entry\" ]; then type=\"dir\"; else type=\"file\"; fi; printf \"%s\\t%s\\n\" \"$type\" \"$entry\"; done";
                const res = await this.execContainerShell(server, containerName, script, [ normalizedPath ]);
                const stdout = res.stdout?.toString("utf-8") || "";

                if (stdout.includes("__DOCKGE_NOT_DIR__")) {
                    throw new ValidationError("Directory not found in container");
                }

                const files = stdout
                    .split("\n")
                    .filter((line) => line.trim())
                    .map((line) => {
                        const [ type, ...nameParts ] = line.split("\t");
                        return {
                            name: nameParts.join("\t"),
                            isDirectory: type === "dir",
                        };
                    })
                    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));

                callbackResult({
                    ok: true,
                    cwd: normalizedPath,
                    files,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("containerFileRead", async (stackName : unknown, serviceName : unknown, containerID : unknown, targetPath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string" || typeof(containerID) !== "string" || typeof(targetPath) !== "string") {
                    throw new ValidationError("Invalid container file request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const containerName = await this.resolveServiceContainer(server, stackName, serviceName, containerID);
                const normalizedPath = this.normalizeContainerPath(targetPath);
                const res = await this.execContainerShell(server, containerName, "cat -- \"$1\"", [ normalizedPath ]);
                callbackResult({
                    ok: true,
                    content: res.stdout?.toString("utf-8") || "",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("containerFileWrite", async (stackName : unknown, serviceName : unknown, containerID : unknown, targetPath : unknown, content : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string" || typeof(containerID) !== "string" || typeof(targetPath) !== "string" || typeof(content) !== "string") {
                    throw new ValidationError("Invalid container file request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const containerName = await this.resolveServiceContainer(server, stackName, serviceName, containerID);
                const normalizedPath = this.normalizeContainerPath(targetPath);
                await this.execContainerShell(server, containerName, "mkdir -p \"$(dirname \"$1\")\" && cat > \"$1\"", [ normalizedPath ], {
                    stdin: Buffer.from(content, "utf-8"),
                    interactive: true,
                });
                callbackResult({
                    ok: true,
                    msg: "Saved",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("containerFileDelete", async (stackName : unknown, serviceName : unknown, containerID : unknown, targetPath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string" || typeof(containerID) !== "string" || typeof(targetPath) !== "string") {
                    throw new ValidationError("Invalid container file request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const containerName = await this.resolveServiceContainer(server, stackName, serviceName, containerID);
                const normalizedPath = this.normalizeContainerPath(targetPath);
                await this.execContainerShell(server, containerName, "rm -rf -- \"$1\"", [ normalizedPath ]);
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("containerFileUpload", async (stackName : unknown, serviceName : unknown, containerID : unknown, currentPath : unknown, fileName : unknown, contentBase64 : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string" || typeof(containerID) !== "string" || typeof(currentPath) !== "string" || typeof(fileName) !== "string" || typeof(contentBase64) !== "string") {
                    throw new ValidationError("Invalid upload request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const containerName = await this.resolveServiceContainer(server, stackName, serviceName, containerID);
                const normalizedPath = this.normalizeContainerPath(path.posix.join(currentPath.replace(/\\/g, "/"), fileName));
                await this.execContainerShell(server, containerName, "mkdir -p \"$(dirname \"$1\")\" && cat > \"$1\"", [ normalizedPath ], {
                    stdin: Buffer.from(contentBase64, "base64"),
                    interactive: true,
                });
                callbackResult({
                    ok: true,
                    msg: "Uploaded",
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("containerFileDownload", async (stackName : unknown, serviceName : unknown, containerID : unknown, targetPath : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(serviceName) !== "string" || typeof(containerID) !== "string" || typeof(targetPath) !== "string") {
                    throw new ValidationError("Invalid download request");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const containerName = await this.resolveServiceContainer(server, stackName, serviceName, containerID);
                const normalizedPath = this.normalizeContainerPath(targetPath);
                const res = await this.execContainerShell(server, containerName, "cat -- \"$1\"", [ normalizedPath ]);
                callbackResult({
                    ok: true,
                    fileName: path.posix.basename(normalizedPath),
                    contentBase64: (res.stdout || Buffer.alloc(0)).toString("base64"),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown) : Promise<Stack> {
        // Check types
        if (typeof(name) !== "string") {
            throw new ValidationError("Name must be a string");
        }
        if (typeof(composeYAML) !== "string") {
            throw new ValidationError("Compose YAML must be a string");
        }
        if (typeof(composeENV) !== "string") {
            throw new ValidationError("Compose ENV must be a string");
        }
        if (typeof(isAdd) !== "boolean") {
            throw new ValidationError("isAdd must be a boolean");
        }

        const stack = new Stack(server, name, composeYAML, composeENV, false);
        await stack.save(isAdd);
        return stack;
    }

    resolveStackFilePath(stack: Stack, relativePath: string) {
        const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
        const stackRoot = path.resolve(stack.fullPath);
        const targetPath = path.resolve(path.join(stackRoot, normalized));

        if (targetPath !== stackRoot && !targetPath.startsWith(stackRoot + path.sep)) {
            throw new ValidationError("Invalid file path");
        }

        return targetPath;
    }

    normalizeContainerPath(targetPath: string) {
        const normalized = path.posix.normalize(targetPath.replace(/\\/g, "/"));
        if (!normalized || normalized === ".") {
            return "/";
        }
        if (normalized.startsWith("/")) {
            return normalized;
        }
        return `/${normalized.replace(/^\/+/, "")}`;
    }

    async resolveServiceContainer(server: DockgeServer, stackName: string, serviceName: string, containerID: string) {
        const stack = await Stack.getStack(server, stackName, true);
        const containers = await stack.getServiceContainers(serviceName);

        if (containers.length === 0) {
            throw new ValidationError("No running container found for this service.");
        }

        const match = containers.find((container) => container.id === containerID || container.name === containerID);
        if (!match) {
            throw new ValidationError("Container not found for this service.");
        }

        return match.name;
    }

    async execContainerShell(server: DockgeServer, containerName: string, script: string, scriptArgs: string[] = [], options: {
        stdin?: Buffer,
        interactive?: boolean,
    } = {}) {
        const shells = [ "sh", "bash" ];
        let lastError: unknown;

        for (const shell of shells) {
            try {
                const args = [
                    "exec",
                    ...(options.interactive ? [ "-i" ] : []),
                    containerName,
                    shell,
                    // Use "-c" (not "-lc"): a login shell can be unsupported by
                    // busybox sh and may print profile/MOTD banners that corrupt
                    // the command output, breaking the file listing.
                    "-c",
                    script,
                    "dockge",
                    ...scriptArgs,
                ];
                const child = await spawnDocker(server, args);

                if (options.stdin) {
                    const childProcess = child as typeof child & {
                        stdin?: {
                            end: (input?: Buffer) => void,
                        },
                    };
                    childProcess.stdin?.end(options.stdin);
                }

                return await child;
            } catch (e) {
                lastError = e;
            }
        }

        throw lastError;
    }

    async getDockerImages(server : DockgeServer) {
        const imageRes = await spawnDocker(server, [ "image", "ls", "--digests", "--no-trunc", "--format", "{{json .}}" ], undefined, {
            encoding: "utf-8",
        });
        const containerRes = await spawnDocker(server, [ "ps", "-a", "--no-trunc", "--format", "{{json .}}" ], undefined, {
            encoding: "utf-8",
        });

        const usedImageRefs = new Set<string>();
        for (const line of (containerRes.stdout?.toString() || "").split("\n")) {
            if (!line.trim()) {
                continue;
            }
            const parsed = JSON.parse(line) as Record<string, string>;
            if (parsed.Image) {
                usedImageRefs.add(parsed.Image);
            }
        }

        return (imageRes.stdout?.toString() || "")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, string>)
            .map((image) => {
                const repoTag = `${image.Repository}:${image.Tag}`;
                return {
                    id: image.ID,
                    repository: image.Repository,
                    tag: image.Tag,
                    size: image.Size,
                    digest: image.Digest,
                    createdSince: image.CreatedSince,
                    used: usedImageRefs.has(repoTag) || usedImageRefs.has(image.ID),
                };
            });
    }

}
