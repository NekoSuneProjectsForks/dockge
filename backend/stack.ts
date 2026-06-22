import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    CREATED_STACK,
    EXITED, getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import { Settings } from "./settings";
import { buildDockerCommand, spawnDocker } from "./docker-cli";

export interface BulkUpdateResult {
    stackName: string;
    ok: boolean;
    updatesFound: boolean;
    restarted: boolean;
    skippedRestart?: boolean;
    error?: string;
    pullSummary?: string;
}

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
        };
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        let res = await spawnDocker(this.server, this.getComposeOptions("ps", "--format", "json"), this.fullPath, {
            encoding: "utf-8",
        });
        if (!res.stdout) {
            return {};
        }
        return JSON.parse(res.stdout.toString());
    }

    get isManagedByDockge() : boolean {
        return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }

    get isEligibleForBulkUpdate() : boolean {
        const stackRoot = path.resolve(this.server.stackDirFullPath);
        const currentStackPath = path.resolve(this.fullPath);

        if (!this.isManagedByDockge) {
            return false;
        }

        return currentStackPath === stackRoot || currentStackPath.startsWith(stackRoot + path.sep);
    }

    get status() : number {
        return this._status;
    }

    validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        // Write or overwrite the compose.yaml
        await fsAsync.writeFile(path.join(dir, this._composeFileName), this.composeYAML);

        const envPath = path.join(dir, ".env");

        // Write or overwrite the .env
        // If .env is not existing and the composeENV is empty, we don't need to write it
        if (await fileExists(envPath) || this.composeENV.trim() !== "") {
            await fsAsync.writeFile(envPath, this.composeENV);
        }
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions("up", "-d", "--remove-orphans"), this.fullPath);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, command.args, command.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to deploy, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions("down", "--remove-orphans"), this.fullPath);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, command.args, command.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to delete, please check the terminal output for more information.");
        }

        // Remove the stack folder
        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return exitCode;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList(this.server);
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Get status from docker compose ls
        let res = await spawnDocker(server, [ "compose", "ls", "--all", "--format", "json" ], undefined, {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return stackList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            stack._status = this.statusConvert(composeStack.Status);
            stack._configFilePath = composeStack.ConfigFiles;
        }

        return stackList;
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed or created to `docker compose` will be returned
     */
    static async getStatusList(server : DockgeServer) : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();

        let res = await spawnDocker(server, [ "compose", "ls", "--all", "--format", "json" ], undefined, {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return statusList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            statusList.set(composeStack.Name, this.statusConvert(composeStack.Status));
        }

        return statusList;
    }

    /**
     * Convert the status string from `docker compose ls` to the status number
     * Input Example: "exited(1), running(1)"
     * @param status
     */
    static statusConvert(status : string) : number {
        if (status.startsWith("created")) {
            return CREATED_STACK;
        } else if (status.includes("exited")) {
            // If one of the service is exited, we consider the stack is exited
            return EXITED;
        } else if (status.startsWith("running")) {
            // If there is no exited services, there should be only running services
            return RUNNING;
        } else {
            return UNKNOWN;
        }
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        // Reject names containing path separators or "..". Without this an
        // admin (whose requireStackAccess check is a no-op) could pass a name
        // like "../../etc" and have file operations escape the stacks dir.
        if (!stackName.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        let dir = path.join(server.stacksDir, stackName);

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    getComposeOptions(command : string, ...extraOptions : string[]) {
        //--env-file ./../global.env --env-file .env
        let options = [ "compose", command, ...extraOptions ];
        if (fs.existsSync(path.join(this.server.stacksDir, "global.env"))) {
            if (fs.existsSync(path.join(this.path, ".env"))) {
                options.splice(1, 0, "--env-file", "./.env");
            }
            options.splice(1, 0, "--env-file", "../global.env");
        }
        console.log(options);
        return options;
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions("up", "-d", "--remove-orphans"), this.fullPath);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, command.args, command.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions("stop"), this.fullPath);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, command.args, command.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions("restart"), this.fullPath);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, command.args, command.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async serviceAction(socket: DockgeSocket, serviceName: string, action: "start" | "stop" | "restart" | "kill") : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions(action, serviceName), this.fullPath);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, command.args, command.cwd || this.fullPath);

        if (exitCode !== 0) {
            throw new Error(`Failed to ${action} service ${serviceName}, please check the terminal output for more information.`);
        }

        return exitCode;
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions("down"), this.fullPath);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, command.args, command.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const pullCommand = await buildDockerCommand(this.server, this.getComposeOptions("pull"), this.fullPath);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, pullCommand.file, pullCommand.args, pullCommand.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        // If the stack is not running, we don't need to restart it
        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (this.status !== RUNNING) {
            return exitCode;
        }

        const upCommand = await buildDockerCommand(this.server, this.getComposeOptions("up", "-d", "--remove-orphans"), this.fullPath);
        exitCode = await Terminal.exec(this.server, socket, terminalName, upCommand.file, upCommand.args, upCommand.cwd || this.fullPath);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }

        // After a successful pull + up, the previous image becomes dangling
        // (untagged). Remove those leftovers so old versions don't pile up.
        await this.pruneDanglingImages();

        return exitCode;
    }

    /**
     * Remove dangling (untagged) images left behind after pulling a newer
     * version of an image. This only removes images that are no longer
     * referenced by any tag or container, so running stacks are never affected.
     */
    async pruneDanglingImages() {
        try {
            await spawnDocker(this.server, [ "image", "prune", "-f" ], undefined, {
                encoding: "utf-8",
            });
        } catch (e) {
            log.warn("pruneDanglingImages", `Failed to prune dangling images: ${e instanceof Error ? e.message : "unknown error"}`);
        }
    }

    async updateForBulk(forceRestart = false): Promise<BulkUpdateResult> {
        const pullRes = await spawnDocker(this.server, this.getComposeOptions("pull"), this.fullPath, {
            encoding: "utf-8",
        });

        const pullOutput = `${pullRes.stdout?.toString() || ""}\n${pullRes.stderr?.toString() || ""}`.trim();
        const updatesFound = Stack.detectPullUpdates(pullOutput);

        await this.updateStatus();

        const shouldRestart = forceRestart || updatesFound;
        const canRestart = forceRestart || this.status === RUNNING;
        let restarted = false;
        let skippedRestart = false;

        if (shouldRestart) {
            if (canRestart) {
                await spawnDocker(this.server, this.getComposeOptions("up", "-d", "--remove-orphans"), this.fullPath, {
                    encoding: "utf-8",
                });
                restarted = true;

                // Clean up the now-dangling old image left over by the pull.
                if (updatesFound) {
                    await this.pruneDanglingImages();
                }
            } else {
                skippedRestart = true;
            }
        }

        return {
            stackName: this.name,
            ok: true,
            updatesFound,
            restarted,
            skippedRestart,
            pullSummary: Stack.summarizePullOutput(pullOutput),
        };
    }

    static detectPullUpdates(output: string) {
        const normalized = output.toLowerCase();
        if (!normalized.trim()) {
            return false;
        }

        const updatedPatterns = [
            "downloaded newer image",
            "pull complete",
            "extracting",
            "downloading",
            "pulling fs layer",
            "status: pulled",
        ];

        return updatedPatterns.some((pattern) => normalized.includes(pattern));
    }

    static summarizePullOutput(output: string) {
        const normalized = output.replace(/\r/g, "\n");
        const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);

        const priorityPatterns = [
            /downloaded newer image/i,
            /image is up to date/i,
            /pull complete/i,
            /error/i,
            /denied/i,
            /unauthorized/i,
        ];

        for (const pattern of priorityPatterns) {
            const match = lines.find((line) => pattern.test(line));
            if (match) {
                return match;
            }
        }

        return lines[lines.length - 1] || "";
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        Terminal.setStackOwner(terminalName, this.name);
        const command = await buildDockerCommand(this.server, this.getComposeOptions("logs", "-f", "--tail", "100"), this.fullPath);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, command.file, command.args, command.cwd || this.fullPath);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        Terminal.setStackOwner(terminalName, this.name);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            const command = await buildDockerCommand(this.server, this.getComposeOptions("exec", serviceName, shell), this.fullPath);
            terminal = new InteractiveTerminal(this.server, terminalName, command.file, command.args, command.cwd || this.fullPath);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, { state: string, ports: string[] }>();

        try {
            let res = await spawnDocker(this.server, this.getComposeOptions("ps", "--format", "json"), this.fullPath, {
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return statusList;
            }

            let lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                try {
                    let obj = JSON.parse(line);
                    let ports = (obj.Ports as string).split(/,\s*/).filter((s) => {
                        return s.indexOf("->") >= 0;
                    });
                    if (obj.Health === "") {
                        statusList.set(obj.Service, {
                            state: obj.State,
                            ports: ports
                        });
                    } else {
                        statusList.set(obj.Service, {
                            state: obj.Health,
                            ports: ports
                        });
                    }
                } catch (e) {
                }
            }

            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }

    }

    async getResourceStatsList() {
        const statsByService = new Map<string, {
            cpuPercent: string,
            memoryUsage: string,
            memoryPercent: string,
            netIO: string,
            blockIO: string,
            pids: string,
            containers: number,
        }>();

        try {
            const psRes = await spawnDocker(this.server, this.getComposeOptions("ps", "--format", "json"), this.fullPath, {
                encoding: "utf-8",
            });

            if (!psRes.stdout) {
                return statsByService;
            }

            const nameToService = new Map<string, string>();
            for (const line of psRes.stdout.toString().split("\n")) {
                if (!line.trim()) {
                    continue;
                }

                try {
                    const obj = JSON.parse(line) as Record<string, string>;
                    if (obj.Name && obj.Service) {
                        nameToService.set(obj.Name, obj.Service);
                    }
                } catch (e) {
                    log.debug("getResourceStatsList", `Failed to parse compose ps line: ${e instanceof Error ? e.message : "unknown error"}`);
                }
            }

            if (nameToService.size === 0) {
                return statsByService;
            }

            const statsRes = await spawnDocker(this.server, [
                "stats",
                "--no-stream",
                "--format",
                "{{json .}}",
                ...Array.from(nameToService.keys()),
            ], undefined, {
                encoding: "utf-8",
            });

            const aggregate = new Map<string, {
                cpuPercentTotal: number,
                memoryUsedTotal: number,
                memoryLimitTotal: number,
                memoryPercentTotal: number,
                netRxTotal: number,
                netTxTotal: number,
                blockReadTotal: number,
                blockWriteTotal: number,
                pidsTotal: number,
                containers: number,
            }>();

            for (const line of (statsRes.stdout?.toString() || "").split("\n")) {
                if (!line.trim()) {
                    continue;
                }

                try {
                    const obj = JSON.parse(line) as Record<string, string>;
                    const containerName = obj.Name || obj.Container;
                    const serviceName = containerName ? nameToService.get(containerName) : undefined;

                    if (!serviceName) {
                        continue;
                    }

                    const memoryUsage = parseUsagePair(obj.MemUsage);
                    const netIO = parseUsagePair(obj.NetIO);
                    const blockIO = parseUsagePair(obj.BlockIO);

                    const current = aggregate.get(serviceName) || {
                        cpuPercentTotal: 0,
                        memoryUsedTotal: 0,
                        memoryLimitTotal: 0,
                        memoryPercentTotal: 0,
                        netRxTotal: 0,
                        netTxTotal: 0,
                        blockReadTotal: 0,
                        blockWriteTotal: 0,
                        pidsTotal: 0,
                        containers: 0,
                    };

                    current.cpuPercentTotal += parsePercent(obj.CPUPerc);
                    current.memoryUsedTotal += memoryUsage[0];
                    current.memoryLimitTotal += memoryUsage[1];
                    current.memoryPercentTotal += parsePercent(obj.MemPerc);
                    current.netRxTotal += netIO[0];
                    current.netTxTotal += netIO[1];
                    current.blockReadTotal += blockIO[0];
                    current.blockWriteTotal += blockIO[1];
                    current.pidsTotal += Number(obj.PIDs || "0") || 0;
                    current.containers += 1;

                    aggregate.set(serviceName, current);
                } catch (e) {
                    log.debug("getResourceStatsList", `Failed to parse docker stats line: ${e instanceof Error ? e.message : "unknown error"}`);
                }
            }

            for (const [ serviceName, item ] of aggregate) {
                const memoryPercent = item.memoryLimitTotal > 0
                    ? (item.memoryUsedTotal / item.memoryLimitTotal) * 100
                    : item.memoryPercentTotal;

                statsByService.set(serviceName, {
                    cpuPercent: `${item.cpuPercentTotal.toFixed(1)}%`,
                    memoryUsage: `${formatDockerBytes(item.memoryUsedTotal)} / ${item.memoryLimitTotal > 0 ? formatDockerBytes(item.memoryLimitTotal) : "N/A"}`,
                    memoryPercent: `${memoryPercent.toFixed(1)}%`,
                    netIO: `${formatDockerBytes(item.netRxTotal)} / ${formatDockerBytes(item.netTxTotal)}`,
                    blockIO: `${formatDockerBytes(item.blockReadTotal)} / ${formatDockerBytes(item.blockWriteTotal)}`,
                    pids: String(item.pidsTotal),
                    containers: item.containers,
                });
            }

            return statsByService;
        } catch (e) {
            log.error("getResourceStatsList", e);
            return statsByService;
        }
    }

    async getServiceContainers(serviceName: string) {
        const containers: Array<{
            id: string,
            name: string,
            service: string,
            state: string,
            health: string,
        }> = [];

        try {
            const res = await spawnDocker(this.server, this.getComposeOptions("ps", "--format", "json"), this.fullPath, {
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return containers;
            }

            for (const line of res.stdout.toString().split("\n")) {
                if (!line.trim()) {
                    continue;
                }

                try {
                    const obj = JSON.parse(line) as Record<string, string>;
                    if (obj.Service !== serviceName || !obj.Name) {
                        continue;
                    }

                    containers.push({
                        id: obj.ID || obj.Name,
                        name: obj.Name,
                        service: obj.Service,
                        state: obj.State || "unknown",
                        health: obj.Health || "",
                    });
                } catch (e) {
                    log.debug("getServiceContainers", `Failed to parse compose ps line: ${e instanceof Error ? e.message : "unknown error"}`);
                }
            }

            return containers;
        } catch (e) {
            log.error("getServiceContainers", e);
            return containers;
        }
    }
}

function parsePercent(value?: string) {
    if (!value) {
        return 0;
    }
    return Number.parseFloat(value.replace("%", "").trim()) || 0;
}

function parseUsagePair(value?: string) {
    if (!value) {
        return [ 0, 0 ];
    }

    const [ left, right ] = value.split(/\s*\/\s*/);
    return [ parseDockerBytes(left), parseDockerBytes(right) ];
}

function parseDockerBytes(value?: string) {
    if (!value) {
        return 0;
    }

    const trimmed = value.trim();
    const match = trimmed.match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
    if (!match) {
        return 0;
    }

    const amount = Number.parseFloat(match[1]);
    const unit = (match[2] || "B").toUpperCase();

    if (Number.isNaN(amount)) {
        return 0;
    }

    const units: Record<string, number> = {
        B: 1,
        KB: 1000,
        KIB: 1024,
        MB: 1000 ** 2,
        MIB: 1024 ** 2,
        GB: 1000 ** 3,
        GIB: 1024 ** 3,
        TB: 1000 ** 4,
        TIB: 1024 ** 4,
        PB: 1000 ** 5,
        PIB: 1024 ** 5,
    };

    return amount * (units[unit] || 1);
}

function formatDockerBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return "0 B";
    }

    const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
    let size = value;
    let index = 0;

    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }

    const precision = index === 0 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[index]}`;
}
