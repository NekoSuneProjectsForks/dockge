import { DockgeServer } from "./dockge-server";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { LimitQueue } from "./utils/limit-queue";
import { DockgeSocket } from "./util-server";
import {
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { log } from "./log";
import { buildDockerConsoleCommand } from "./docker-cli";

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {
    protected static terminalMap : Map<string, Terminal> = new Map();
    protected static pendingSocketJoinMap : Map<string, Record<string, DockgeSocket>> = new Map();

    // Maps a terminal name to the stack it belongs to, so socket handlers can
    // enforce per-stack access control (requireStackAccess) before letting a
    // client write to / read from / resize a terminal by name.
    protected static terminalStackMap : Map<string, string> = new Map();

    protected _ptyProcess? : pty.IPty;
    protected server : DockgeServer;
    protected buffer : LimitQueue<string> = new LimitQueue(100);
    protected _name : string;

    protected file : string;
    protected args : string | string[];
    protected cwd : string;
    protected callback? : (exitCode : number) => void;

    protected _rows : number = TERMINAL_ROWS;
    protected _cols : number = TERMINAL_COLS;

    public enableKeepAlive : boolean = false;
    protected keepAliveInterval? : NodeJS.Timeout;
    protected kickDisconnectedClientsInterval? : NodeJS.Timeout;

    protected socketList : Record<string, DockgeSocket> = {};

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) {
        this.server = server;
        this._name = name;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;

        Terminal.terminalMap.set(this.name, this);
        Terminal.attachPendingSockets(this);
    }

    get rows() {
        return this._rows;
    }

    set rows(rows : number) {
        this._rows = rows;
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    get cols() {
        return this._cols;
    }

    set cols(cols : number) {
        this._cols = cols;
        log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    public start() {
        if (this._ptyProcess) {
            return;
        }

        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

            // Close if there is no clients
            this.keepAliveInterval = setInterval(() => {
                const numClients = Object.keys(this.socketList).length;

                if (numClients === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                } else {
                    log.debug("Terminal", "Terminal " + this.name + " has " + numClients + " client(s)");
                }
            }, 60 * 1000);
        } else {
            log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
        }

        try {
            this._ptyProcess = pty.spawn(this.file, this.args, {
                name: this.name,
                cwd: this.cwd,
                cols: TERMINAL_COLS,
                rows: this.rows,
            });

            // On Data
            this._ptyProcess.onData((data) => {
                this.buffer.pushItem(data);

                for (const socketID in this.socketList) {
                    const socket = this.socketList[socketID];
                    socket.emitAgent("terminalWrite", this.name, data);
                }
            });

            // On Exit
            this._ptyProcess.onExit(this.exit);
        } catch (error) {
            if (error instanceof Error) {
                clearInterval(this.keepAliveInterval);

                log.error("Terminal", "Failed to start terminal: " + error.message);
                const exitCode = Number(error.message.split(" ").pop());
                this.exit({
                    exitCode,
                });
            }
        }
    }

    /**
     * Exit event handler
     * @param res
     */
    protected exit = (res : {exitCode: number, signal?: number | undefined}) => {
        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalExit", this.name, res.exitCode);
        }

        // Remove all clients
        this.socketList = {};

        Terminal.terminalMap.delete(this.name);
        Terminal.terminalStackMap.delete(this.name);
        log.debug("Terminal", "Terminal " + this.name + " exited with code " + res.exitCode);

        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        if (this.callback) {
            this.callback(res.exitCode);
        }
    };

    public onExit(callback : (exitCode : number) => void) {
        this.callback = callback;
    }

    public join(socket : DockgeSocket) {
        this.socketList[socket.id] = socket;
        Terminal.unregisterPendingJoin(this.name, socket);
    }

    public leave(socket : DockgeSocket) {
        delete this.socketList[socket.id];
        Terminal.unregisterPendingJoin(this.name, socket);
    }

    public get ptyProcess() {
        return this._ptyProcess;
    }

    public get name() {
        return this._name;
    }

    /**
     * Get the terminal output string
     */
    getBuffer() : string {
        if (this.buffer.length === 0) {
            return "";
        }
        return this.buffer.join("");
    }

    close() {
        clearInterval(this.keepAliveInterval);
        // Send Ctrl+C to the terminal
        this.ptyProcess?.write("\x03");
    }

    cancel() {
        clearInterval(this.keepAliveInterval);
        this.ptyProcess?.write("\x03");

        setTimeout(() => {
            try {
                this.ptyProcess?.kill();
            } catch (e) {
                if (e instanceof Error) {
                    log.debug("Terminal", "Failed to kill terminal: " + e.message);
                }
            }
        }, 3000);
    }

    /**
     * Get a running and non-exited terminal
     * @param name
     */
    public static getTerminal(name : string) : Terminal | undefined {
        return Terminal.terminalMap.get(name);
    }

    /**
     * Associate a terminal name with the stack that owns it, for access control.
     * @param name Terminal name
     * @param stackName Stack the terminal belongs to
     */
    public static setStackOwner(name : string, stackName : string) {
        Terminal.terminalStackMap.set(name, stackName);
    }

    /**
     * Get the stack that owns a terminal, if any.
     * @param name Terminal name
     * @returns Stack name or undefined
     */
    public static getStackOwner(name : string) : string | undefined {
        return Terminal.terminalStackMap.get(name);
    }

    public static getOrCreateTerminal(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) : Terminal {
        // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
        let terminal = Terminal.getTerminal(name);
        if (!terminal) {
            terminal = new Terminal(server, name, file, args, cwd);
        }
        return terminal;
    }

    public static exec(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string) : Promise<number> {
        return new Promise((resolve, reject) => {
            // check if terminal exists
            if (Terminal.terminalMap.has(terminalName)) {
                reject("Another operation is already running, please try again later.");
                return;
            }

            // Use an InteractiveTerminal so the user can answer interactive
            // prompts (e.g. docker compose "[y/N]" confirmations) or press
            // Ctrl+C from the progress terminal instead of getting stuck.
            let terminal = new InteractiveTerminal(server, terminalName, file, args, cwd);
            terminal.rows = PROGRESS_TERMINAL_ROWS;

            if (socket) {
                terminal.join(socket);
            }

            terminal.onExit((exitCode : number) => {
                resolve(exitCode);
            });
            terminal.start();
        });
    }

    public static getTerminalCount() {
        return Terminal.terminalMap.size;
    }

    public static cancel(name : string) {
        const terminal = Terminal.getTerminal(name);
        if (!terminal) {
            return false;
        }
        terminal.cancel();
        return true;
    }

    public static registerPendingJoin(name: string, socket: DockgeSocket) {
        if (Terminal.terminalMap.has(name)) {
            Terminal.terminalMap.get(name)?.join(socket);
            return;
        }

        if (!Terminal.pendingSocketJoinMap.has(name)) {
            Terminal.pendingSocketJoinMap.set(name, {});
        }

        Terminal.pendingSocketJoinMap.get(name)![socket.id] = socket;
    }

    public static unregisterPendingJoin(name: string, socket: DockgeSocket) {
        const waitingSockets = Terminal.pendingSocketJoinMap.get(name);
        if (!waitingSockets) {
            return;
        }

        delete waitingSockets[socket.id];

        if (Object.keys(waitingSockets).length === 0) {
            Terminal.pendingSocketJoinMap.delete(name);
        }
    }

    protected static attachPendingSockets(terminal: Terminal) {
        const waitingSockets = Terminal.pendingSocketJoinMap.get(terminal.name);
        if (!waitingSockets) {
            return;
        }

        for (const socketID in waitingSockets) {
            const socket = waitingSockets[socketID];
            if (socket.connected) {
                terminal.join(socket);
            }
        }

        Terminal.pendingSocketJoinMap.delete(terminal.name);
    }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
    public write(input : string) {
        this.ptyProcess?.write(input);
    }

    resetCWD() {
        const cwd = process.cwd();
        this.ptyProcess?.write(`cd "${cwd}"\r`);
    }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
    constructor(server : DockgeServer, name : string, file : string, args : string[], cwd : string) {
        // Throw an error if console is not enabled
        if (!server.config.enableConsole) {
            throw new Error("Console is not enabled.");
        }
        super(server, name, file, args, cwd);
    }

    public write(input : string) {
        super.write(input);
    }

    static async create(server : DockgeServer, name : string) {
        const command = await buildDockerConsoleCommand(server);
        return new MainTerminal(server, name, command.file, command.args, command.cwd || server.stacksDir);
    }
}
