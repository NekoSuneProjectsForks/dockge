import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, fileExists, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { requireAdmin, requireStackAccess } from "../auth";
import { promises as fsAsync } from "fs";
import path from "path";
import AdmZip from "adm-zip";
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

        // Export a Dockge-managed stack folder as a zip (base64) so it can be
        // transferred to another node.
        agentSocket.on("exportStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                await requireStackAccess(socket, stackName, socket.endpoint);

                const stack = await Stack.getStack(server, stackName);
                if (!stack.isManagedByDockge) {
                    throw new ValidationError("Only Dockge-managed stacks can be transferred.");
                }

                const zip = new AdmZip();
                zip.addLocalFolder(stack.fullPath);

                callbackResult({
                    ok: true,
                    stackName: stack.name,
                    contentBase64: zip.toBuffer().toString("base64"),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Import a stack zip (base64) onto this node, optionally deploying it.
        // Used as the receiving end of a node-to-node transfer.
        agentSocket.on("importStack", async (stackName : unknown, contentBase64 : unknown, deploy : unknown, callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);

                if (typeof(stackName) !== "string" || typeof(contentBase64) !== "string") {
                    throw new ValidationError("Invalid import request");
                }
                if (!stackName.match(/^[a-z0-9_-]+$/)) {
                    throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
                }

                const targetDir = path.join(server.stacksDir, stackName);
                if (await fileExists(targetDir)) {
                    throw new ValidationError("A stack with this name already exists on the target node.");
                }

                const zip = new AdmZip(Buffer.from(contentBase64, "base64"));
                const root = path.resolve(targetDir);
                await fsAsync.mkdir(root, { recursive: true });

                // Extract each entry manually with zip-slip protection so a
                // malicious archive cannot write outside the stack folder.
                for (const entry of zip.getEntries()) {
                    const entryPath = path.resolve(root, entry.entryName);
                    if (entryPath !== root && !entryPath.startsWith(root + path.sep)) {
                        throw new ValidationError(`Unsafe path in archive: ${entry.entryName}`);
                    }

                    if (entry.isDirectory) {
                        await fsAsync.mkdir(entryPath, { recursive: true });
                    } else {
                        await fsAsync.mkdir(path.dirname(entryPath), { recursive: true });
                        await fsAsync.writeFile(entryPath, entry.getData());
                    }
                }

                server.sendStackList();

                if (Boolean(deploy)) {
                    const stack = await Stack.getStack(server, stackName);
                    await stack.deploy(socket);
                    server.sendStackList();
                    stack.joinCombinedTerminal(socket);
                }

                callbackResult({
                    ok: true,
                    msg: "Stack imported.",
                    stackName,
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
