import { io } from "socket.io-client";
import { Socket } from "socket.io-client";
import { defineComponent } from "vue";
import jwtDecode from "jwt-decode";
import { Terminal } from "@xterm/xterm";
import { AgentSocket } from "../../../common/agent-socket";

let socket : Socket;

let terminalMap : Map<string, Terminal> = new Map();
let terminalListenerMap : Map<string, Set<{ onWrite?: (data: string) => void, onExit?: (exitCode: number) => void }>> = new Map();

export default defineComponent({
    data() {
        return {
            socketIO: {
                token: null,
                firstConnect: true,
                connected: false,
                connectCount: 0,
                initedSocketIO: false,
                connectionErrorMsg: `${this.$t("Cannot connect to the socket server.")} ${this.$t("Reconnecting...")}`,
                showReverseProxyGuide: true,
                connecting: false,
            },
            info: {

            },
            remember: (localStorage.remember !== "0"),
            loggedIn: false,
            allowLoginDialog: false,
            username: null,
            sessionUser: null,
            composeTemplate: "",
            pendingAppInstall: null,

            stackList: {},

            // All stack list from all agents
            allAgentStackList: {} as Record<string, object>,

            // online / offline / connecting
            agentStatusList: {

            },

            // Agent List
            agentList: {

            },

            updateAllProgressMap: {} as Record<string, object>,

            // Node-to-node transfer progress, keyed by client transfer id
            transferProgressMap: {} as Record<string, object>,
        };
    },
    computed: {
        isAdmin() {
            return this.sessionUser?.role === "admin";
        },

        isOwner() {
            return this.sessionUser?.owner === true;
        },

        agentCount() {
            return Object.keys(this.agentList).length;
        },

        completeStackList() {
            let list : Record<string, object> = {};

            for (let stackName in this.stackList) {
                list[stackName + "_"] = this.stackList[stackName];
            }

            for (let endpoint in this.allAgentStackList) {
                let instance = this.allAgentStackList[endpoint];
                for (let stackName in instance.stackList) {
                    list[stackName + "_" + endpoint] = instance.stackList[stackName];
                }
            }
            return list;
        },

        usernameFirstChar() {
            if (typeof this.username == "string" && this.username.length >= 1) {
                return this.username.charAt(0).toUpperCase();
            } else {
                return "🐬";
            }
        },

        /**
         *  Frontend Version
         *  It should be compiled to a static value while building the frontend.
         *  Please see ./frontend/vite.config.ts, it is defined via vite.js
         * @returns {string}
         */
        frontendVersion() {
            // eslint-disable-next-line no-undef
            return FRONTEND_VERSION;
        },

        /**
         * Are both frontend and backend in the same version?
         * @returns {boolean}
         */
        isFrontendBackendVersionMatched() {
            if (!this.info.version) {
                return true;
            }
            return this.info.version === this.frontendVersion;
        },

    },
    watch: {

        "socketIO.connected"() {
            if (this.socketIO.connected) {
                this.agentStatusList[""] = "online";
            } else {
                this.agentStatusList[""] = "offline";
            }
        },

        remember() {
            localStorage.remember = (this.remember) ? "1" : "0";
        },

        // Reload the SPA if the server version is changed.
        "info.version"(to, from) {
            if (from && from !== to) {
                window.location.reload();
            }
        },
    },
    created() {
        window.addEventListener("message", this.handleOAuthMessage);
        window.addEventListener("storage", this.handleOAuthStorage);
        this.initSocketIO();
    },
    beforeUnmount() {
        window.removeEventListener("message", this.handleOAuthMessage);
        window.removeEventListener("storage", this.handleOAuthStorage);
    },
    mounted() {
        return;

    },
    methods: {

        endpointDisplayFunction(endpoint : string) {
            if (!endpoint) {
                return this.$t("currentEndpoint");
            }

            const agent = this.agentList[endpoint];
            const nickname = agent?.nickname?.trim?.();
            if (nickname) {
                return `${nickname} (${endpoint})`;
            }

            return endpoint;
        },

        /**
         * Initialize connection to socket server
         * @param bypass Should the check for if we
         * are on a status page be bypassed?
         */
        initSocketIO(bypass = false) {
            // No need to re-init
            if (this.socketIO.initedSocketIO) {
                return;
            }

            this.socketIO.initedSocketIO = true;
            let url : string;
            const env = process.env.NODE_ENV || "production";
            if (env === "development" || localStorage.dev === "dev") {
                url = location.protocol + "//" + location.hostname + ":5001";
            } else {
                url = location.protocol + "//" + location.host;
            }

            let connectingMsgTimeout = setTimeout(() => {
                this.socketIO.connecting = true;
            }, 1500);

            socket = io(url);

            // Handling events from agents
            let agentSocket = new AgentSocket();
            socket.on("agent", (eventName : unknown, ...args : unknown[]) => {
                agentSocket.call(eventName, ...args);
            });

            socket.on("connect", () => {
                console.log("Connected to the socket server");

                clearTimeout(connectingMsgTimeout);
                this.socketIO.connecting = false;

                this.socketIO.connectCount++;
                this.socketIO.connected = true;
                this.socketIO.showReverseProxyGuide = false;
                const token = this.storage().token;

                if (token) {
                    if (token !== "autoLogin") {
                        console.log("Logging in by token");
                        this.loginByToken(token);
                    } else {
                        // Timeout if it is not actually auto login
                        setTimeout(() => {
                            if (! this.loggedIn) {
                                this.allowLoginDialog = true;
                                this.storage().removeItem("token");
                            }
                        }, 5000);
                    }
                } else {
                    this.allowLoginDialog = true;
                }

                this.socketIO.firstConnect = false;
            });

            socket.on("disconnect", () => {
                console.log("disconnect");
                this.socketIO.connectionErrorMsg = `${this.$t("Lost connection to the socket server. Reconnecting...")}`;
                this.socketIO.connected = false;
            });

            socket.on("connect_error", (err) => {
                console.error(`Failed to connect to the backend. Socket.io connect_error: ${err.message}`);
                this.socketIO.connectionErrorMsg = `${this.$t("Cannot connect to the socket server.")} [${err}] ${this.$t("reconnecting...")}`;
                this.socketIO.showReverseProxyGuide = true;
                this.socketIO.connected = false;
                this.socketIO.firstConnect = false;
                this.socketIO.connecting = false;
            });

            // Custom Events

            socket.on("info", (info) => {
                this.info = info;
            });

            socket.on("session", (res) => {
                if (res.ok) {
                    this.sessionUser = res.user;
                    this.username = res.user.username;
                }
            });

            socket.on("autoLogin", () => {
                this.loggedIn = true;
                this.storage().token = "autoLogin";
                this.socketIO.token = "autoLogin";
                this.allowLoginDialog = false;
                this.afterLogin();
            });

            socket.on("setup", () => {
                console.log("setup");
                this.$router.push("/setup");
            });

            agentSocket.on("terminalWrite", (terminalName, data) => {
                const terminal = terminalMap.get(terminalName);
                if (terminal) {
                    terminal.write(data);
                }

                const listeners = terminalListenerMap.get(terminalName);
                if (listeners) {
                    for (const listener of listeners) {
                        listener.onWrite?.(data);
                    }
                }
            });

            agentSocket.on("terminalExit", (terminalName, exitCode) => {
                const listeners = terminalListenerMap.get(terminalName);
                if (listeners) {
                    for (const listener of listeners) {
                        listener.onExit?.(exitCode);
                    }
                }
            });

            agentSocket.on("stackList", (res) => {
                if (res.ok) {
                    if (!res.endpoint) {
                        this.stackList = res.stackList;
                    } else {
                        if (!this.allAgentStackList[res.endpoint]) {
                            this.allAgentStackList[res.endpoint] = {
                                stackList: {},
                            };
                        }
                        this.allAgentStackList[res.endpoint].stackList = res.stackList;
                    }
                }
            });

            agentSocket.on("updateAllStacksProgress", (res) => {
                if (res && typeof res === "object") {
                    const endpoint = typeof res.endpoint === "string" ? res.endpoint : "";
                    this.updateAllProgressMap[endpoint] = res;
                }
            });

            agentSocket.on("transferProgress", (res) => {
                if (res && typeof res === "object" && typeof res.transferId === "string") {
                    this.transferProgressMap[res.transferId] = res;
                }
            });

            socket.on("stackStatusList", (res) => {
                if (res.ok) {
                    for (let stackName in res.stackStatusList) {
                        const stackObj = this.stackList[stackName];
                        if (stackObj) {
                            stackObj.status = res.stackStatusList[stackName];
                        }
                    }
                }
            });

            socket.on("agentStatus", (res) => {
                this.agentStatusList[res.endpoint] = res.status;

                if (res.msg) {
                    this.toastError(res.msg);
                }
            });

            socket.on("agentList", (res) => {
                if (res.ok) {
                    this.agentList = res.agentList;
                }
            });

            socket.on("refresh", () => {
                location.reload();
            });
        },

        /**
         * The storage currently in use
         * @returns Current storage
         */
        storage() : Storage {
            return (this.remember) ? localStorage : sessionStorage;
        },

        getSocket() : Socket {
            return socket;
        },

        emitAgent(endpoint : string, eventName : string, ...args : unknown[]) {
            this.getSocket().emit("agent", endpoint, eventName, ...args);
        },

        /**
         * Get payload of JWT cookie
         * @returns {(object | undefined)} JWT payload
         */
        getJWTPayload() {
            const jwtToken = this.storage().token;

            if (jwtToken && jwtToken !== "autoLogin") {
                return jwtDecode(jwtToken);
            }
            return undefined;
        },

        /**
         * Send request to log user in
         * @param {string} username Username to log in with
         * @param {string} password Password to log in with
         * @param {string} token User token
         * @param {loginCB} callback Callback to call with result
         * @returns {void}
         */
        login(username : string, password : string, token : string, callback) {
            this.getSocket().emit("login", {
                username,
                password,
                token,
            }, (res) => {
                if (res.tokenRequired) {
                    callback(res);
                }

                if (res.ok) {
                    this.storage().token = res.token;
                    this.socketIO.token = res.token;
                    this.loggedIn = true;
                    this.username = this.getJWTPayload()?.username;
                    this.getSocket().emit("getSession", () => {});

                    this.afterLogin();

                    // Trigger Chrome Save Password
                    history.pushState({}, "");
                }

                callback(res);
            });
        },

        /**
         * Log in using a token
         * @param {string} token Token to log in with
         * @returns {void}
         */
        loginByToken(token : string) {
            socket.emit("loginByToken", token, (res) => {
                this.allowLoginDialog = true;

                if (! res.ok) {
                    this.logout();
                } else {
                    this.loggedIn = true;
                    this.username = this.getJWTPayload()?.username;
                    this.getSocket().emit("getSession", () => {});
                    this.afterLogin();
                }
            });
        },

        /**
         * Log out of the web application
         * @returns {void}
         */
        logout() {
            socket.emit("logout", () => { });
            this.storage().removeItem("token");
            this.socketIO.token = null;
            this.loggedIn = false;
            this.username = null;
            this.sessionUser = null;
            this.clearData();
        },

        /**
         * @returns {void}
         */
        clearData() {

        },

        afterLogin() {

        },

        startOAuthLogin(providerID : string) {
            const popup = window.open(`/auth/oauth/start/${providerID}`, "dockge-oauth", "width=640,height=760");
            if (!popup) {
                location.href = `/auth/oauth/start/${providerID}`;
            }
        },

        handleOAuthMessage(event : MessageEvent) {
            if (event.origin !== window.location.origin) {
                return;
            }
            if (event.data?.type !== "dockge-oauth" || !event.data.token) {
                return;
            }
            this.storage().token = event.data.token;
            this.socketIO.token = event.data.token;
            this.loginByToken(event.data.token);
        },

        handleOAuthStorage(event : StorageEvent) {
            if (event.key !== "dockge-oauth-token" || !event.newValue) {
                return;
            }
            localStorage.removeItem("dockge-oauth-token");
            this.storage().token = event.newValue;
            this.socketIO.token = event.newValue;
            this.loginByToken(event.newValue);
        },

        bindTerminal(endpoint : string, terminalName : string, terminal : Terminal) {
            // Load terminal, get terminal screen
            this.emitAgent(endpoint, "terminalJoin", terminalName, (res) => {
                if (res.ok) {
                    terminal.write(res.buffer);
                    terminalMap.set(terminalName, terminal);
                } else {
                    this.toastRes(res);
                }
            });
        },

        unbindTerminal(terminalName : string) {
            terminalMap.delete(terminalName);
        },

        addTerminalListener(terminalName : string, listener: { onWrite?: (data: string) => void, onExit?: (exitCode: number) => void }) {
            if (!terminalListenerMap.has(terminalName)) {
                terminalListenerMap.set(terminalName, new Set());
            }
            terminalListenerMap.get(terminalName)?.add(listener);
        },

        removeTerminalListener(terminalName : string, listener: { onWrite?: (data: string) => void, onExit?: (exitCode: number) => void }) {
            const listeners = terminalListenerMap.get(terminalName);
            if (!listeners) {
                return;
            }
            listeners.delete(listener);
            if (listeners.size === 0) {
                terminalListenerMap.delete(terminalName);
            }
        },

    }
});
