// @ts-ignore
import composerize from "composerize";
import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { R } from "redbean-node";
import { loginRateLimiter } from "../rate-limiter";
import { generatePasswordHash, needRehashPassword, shake256, SHAKE256_LENGTH, verifyPassword } from "../password-hash";
import { User } from "../models/user";
import {
    callbackError,
    checkLogin,
    DockgeSocket,
    doubleCheckPassword,
    JWTDecoded,
    ValidationError
} from "../util-server";
import { passwordStrength } from "check-password-strength";
import jwt from "jsonwebtoken";
import { Settings } from "../settings";
import fs, { promises as fsAsync } from "fs";
import path from "path";
import { getCurrentUser, getStackAssignments, requireAdmin, sessionUserPayload, setStackAssignments } from "../auth";
import { genSecret } from "../../common/util-common";
import { getAppCatalog } from "../app-catalog";
import { getOAuthProviderPresets } from "../oauth";

export class MainSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {

        // ***************************
        // Public Socket API
        // ***************************

        // Setup
        socket.on("setup", async (username, password, callback) => {
            try {
                if (passwordStrength(password).value === "Too weak") {
                    throw new Error("Password is too weak. It should contain alphabetic and numeric characters. It must be at least 6 characters in length.");
                }

                if ((await R.knex("user").count("id as count").first()).count !== 0) {
                    throw new Error("Dockge has been initialized. If you want to run setup again, please delete the database.");
                }

                const user = R.dispense("user");
                user.username = username;
                user.password = generatePasswordHash(password);
                user.display_name = username;
                user.role = "admin";
                user.owner = true;
                user.auth_provider = "local";
                await R.store(user);

                server.needSetup = false;

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Login by token
        socket.on("loginByToken", async (token, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by token. IP=${clientIP}`);

            try {
                const decoded = jwt.verify(token, server.jwtSecret) as JWTDecoded;

                log.info("auth", "Username from JWT: " + decoded.username);

                const user = await R.findOne("user", " username = ? AND active = 1 ", [
                    decoded.username,
                ]) as User;

                if (user) {
                    // Check if the password changed
                    if (decoded.h !== shake256(user.password, SHAKE256_LENGTH)) {
                        throw new Error("The token is invalid due to password change or old token");
                    }

                    log.debug("auth", "afterLogin");
                    await server.afterLogin(socket, user);
                    log.debug("auth", "afterLogin ok");

                    log.info("auth", `Successfully logged in user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                    });
                } else {

                    log.info("auth", `Inactive or deleted user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: false,
                        msg: "authUserInactiveOrDeleted",
                        msgi18n: true,
                    });
                }
            } catch (error) {
                if (!(error instanceof Error)) {
                    console.error("Unknown error:", error);
                    return;
                }
                log.error("auth", `Invalid token. IP=${clientIP}`);
                if (error.message) {
                    log.error("auth", error.message + ` IP=${clientIP}`);
                }
                callback({
                    ok: false,
                    msg: "authInvalidToken",
                    msgi18n: true,
                });
            }

        });

        // Login
        socket.on("login", async (data, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by username + password. IP=${clientIP}`);

            // Checking
            if (typeof callback !== "function") {
                return;
            }

            if (!data) {
                return;
            }

            // Login Rate Limit
            if (!await loginRateLimiter.pass(callback)) {
                log.info("auth", `Too many failed requests for user ${data.username}. IP=${clientIP}`);
                return;
            }

            const user = await this.login(data.username, data.password);

            if (user) {
                // Use an else-if chain so a stray `token` sent with a normal
                // (non-2FA) login can never reach the 2FA branch below, and so
                // only ONE callback is ever invoked per login.
                if (user.twofa_status !== 1) {
                    server.afterLogin(socket, user);

                    log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                        token: User.createJWT(user, server.jwtSecret),
                    });
                } else if (!data.token) {

                    log.info("auth", `2FA token required for user ${data.username}. IP=${clientIP}`);

                    callback({
                        tokenRequired: true,
                    });
                } else {
                    // 2FA verification is not implemented in this build (no TOTP
                    // library and no enrollment flow). Fail closed rather than
                    // crash with a ReferenceError on an undefined `notp`. If a
                    // 2FA-enabled account exists it must be reset via the CLI.
                    log.warn("auth", `2FA login attempted but 2FA verification is not available. user=${data.username} IP=${clientIP}`);

                    callback({
                        ok: false,
                        msg: "authInvalidToken",
                        msgi18n: true,
                    });
                }
            } else {

                log.warn("auth", `Incorrect username or password for user ${data.username}. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: "authIncorrectCreds",
                    msgi18n: true,
                });
            }

        });

        socket.on("logout", async (callback) => {
            socket.userID = 0;
            socket.sessionUser = undefined;
            if (typeof callback === "function") {
                callback({
                    ok: true,
                });
            }
        });

        socket.on("getSession", async (callback) => {
            try {
                checkLogin(socket);
                const user = await getCurrentUser(socket);
                callback({
                    ok: true,
                    user: sessionUserPayload(user),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Change Password
        socket.on("changePassword", async (password, callback) => {
            try {
                checkLogin(socket);

                if (! password.newPassword) {
                    throw new Error("Invalid new password");
                }

                if (passwordStrength(password.newPassword).value === "Too weak") {
                    throw new Error("Password is too weak. It should contain alphabetic and numeric characters. It must be at least 6 characters in length.");
                }

                let user = await doubleCheckPassword(socket, password.currentPassword);
                if (user.auth_provider !== "local") {
                    throw new Error("Password changes are only available for local accounts.");
                }
                await user.resetPassword(password.newPassword);

                server.disconnectAllSocketClients(user.id, socket.id);

                callback({
                    ok: true,
                    msg: "Password has been updated successfully.",
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("getSettings", async (callback) => {
            try {
                checkLogin(socket);
                const user = await getCurrentUser(socket);
                const data = await Settings.getSettings("general");

                if (user.role === "admin" && fs.existsSync(path.join(server.stacksDir, "global.env"))) {
                    data.globalENV = fs.readFileSync(path.join(server.stacksDir, "global.env"), "utf-8");
                } else {
                    data.globalENV = "# VARIABLE=value #comment";
                }

                if (user.role !== "admin") {
                    callback({
                        ok: true,
                        data: {
                            disableAuth: data.disableAuth || false,
                            readonly: true,
                        },
                    });
                    return;
                }

                callback({
                    ok: true,
                    data: data,
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("setSettings", async (data, currentPassword, callback) => {
            try {
                checkLogin(socket);
                await requireAdmin(socket);

                // If currently is disabled auth, don't need to check
                // Disabled Auth + Want to Disable Auth => No Check
                // Disabled Auth + Want to Enable Auth => No Check
                // Enabled Auth + Want to Disable Auth => Check!!
                // Enabled Auth + Want to Enable Auth => No Check
                const currentDisabledAuth = await Settings.get("disableAuth");
                if (!currentDisabledAuth && data.disableAuth) {
                    await doubleCheckPassword(socket, currentPassword);
                }
                // Handle global.env
                if (data.globalENV && data.globalENV != "# VARIABLE=value #comment") {
                    await fsAsync.writeFile(path.join(server.stacksDir, "global.env"), data.globalENV);
                } else {
                    await fsAsync.rm(path.join(server.stacksDir, "global.env"), {
                        recursive: true,
                        force: true
                    });
                }
                delete data.globalENV;

                await Settings.setSettings("general", data);

                callback({
                    ok: true,
                    msg: "Saved"
                });

                server.sendInfo(socket);

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Disconnect all other socket clients of the user
        socket.on("disconnectOtherSocketClients", async () => {
            try {
                checkLogin(socket);
                server.disconnectAllSocketClients(socket.userID, socket.id);
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("disconnectOtherSocketClients", e.message);
                }
            }
        });

        // composerize
        socket.on("composerize", async (dockerRunCommand : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(dockerRunCommand) !== "string") {
                    throw new ValidationError("dockerRunCommand must be a string");
                }

                // Option: 'latest' | 'v2x' | 'v3x'
                let composeTemplate = composerize(dockerRunCommand, "", "latest");

                // Remove the first line "name: <your project name>"
                composeTemplate = composeTemplate.split("\n").slice(1).join("\n");

                callback({
                    ok: true,
                    composeTemplate,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("getAppCatalog", async (callback) => {
            try {
                checkLogin(socket);
                callback({
                    ok: true,
                    apps: getAppCatalog(),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("adminListUsers", async (callback) => {
            try {
                await requireAdmin(socket);
                const users = await R.getAll("SELECT id, username, COALESCE(display_name, username) as displayName, role, auth_provider as authProvider, active, owner FROM user ORDER BY owner DESC, username");
                callback({
                    ok: true,
                    users,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("adminSaveUser", async (requestData, callback) => {
            try {
                await requireAdmin(socket);

                if (typeof requestData !== "object" || requestData === null) {
                    throw new ValidationError("User data must be an object");
                }

                const data = requestData as Record<string, unknown>;
                const username = String(data.username || "").trim();
                const displayName = String(data.displayName || username).trim();
                const role = data.role === "user" ? "user" : "admin";
                const password = String(data.password || "");
                const authProvider = data.authProvider === "oauth" ? "oauth" : "local";
                const id = Number(data.id || 0);

                if (!username) {
                    throw new ValidationError("Username is required");
                }

                let user;
                if (id) {
                    user = await R.findOne("user", " id = ? ", [ id ]);
                    if (!user) {
                        throw new ValidationError("User not found");
                    }
                    if (user.owner) {
                        if (user.username !== username || (user.display_name || user.username) !== displayName || user.role !== "admin" || user.auth_provider !== "local" || data.active === false || password) {
                            throw new ValidationError("Owner account is locked and cannot be edited.");
                        }
                    }
                } else {
                    user = R.dispense("user");
                    user.owner = false;
                }

                user.username = username;
                user.display_name = displayName;
                user.role = role;
                user.auth_provider = authProvider;
                user.active = data.active !== false;

                if (!id) {
                    if (authProvider === "local") {
                        if (!password) {
                            throw new ValidationError("Password is required for local users");
                        }
                        user.password = generatePasswordHash(password);
                    } else {
                        user.password = generatePasswordHash(genSecret());
                    }
                } else if (password) {
                    user.password = generatePasswordHash(password);
                }

                await R.store(user);

                callback({
                    ok: true,
                    msg: "Saved",
                    userID: user.id,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("adminDeleteUser", async (userID, callback) => {
            try {
                await requireAdmin(socket);
                if (typeof userID !== "number") {
                    throw new ValidationError("User ID must be a number");
                }
                const user = await R.findOne("user", " id = ? ", [ userID ]);
                if (!user) {
                    throw new ValidationError("User not found");
                }
                if (user.owner) {
                    throw new ValidationError("Owner account cannot be deleted.");
                }
                await R.exec("DELETE FROM user WHERE id = ? ", [ userID ]);
                callback({
                    ok: true,
                    msg: "Deleted",
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("adminGetUserAssignments", async (userID, callback) => {
            try {
                await requireAdmin(socket);
                if (typeof userID !== "number") {
                    throw new ValidationError("User ID must be a number");
                }
                callback({
                    ok: true,
                    assignments: await getStackAssignments(userID),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("adminSetUserAssignments", async (userID, assignments, callback) => {
            try {
                await requireAdmin(socket);
                if (typeof userID !== "number" || !Array.isArray(assignments)) {
                    throw new ValidationError("Invalid assignments");
                }
                const user = await R.findOne("user", " id = ? ", [ userID ]);
                if (!user) {
                    throw new ValidationError("User not found");
                }
                if (user.owner) {
                    throw new ValidationError("Owner account permissions cannot be changed.");
                }
                await setStackAssignments(userID, assignments.map((item) => ({
                    stackName: String(item.stackName || ""),
                    endpoint: String(item.endpoint || ""),
                })).filter((item) => item.stackName));
                callback({
                    ok: true,
                    msg: "Saved",
                });
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("adminGetOAuthSettings", async (callback) => {
            try {
                await requireAdmin(socket);
                callback({
                    ok: true,
                    providers: await Settings.get("oauthProviders") || [],
                    presets: getOAuthProviderPresets(),
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("adminSetOAuthSettings", async (requestData, callback) => {
            try {
                await requireAdmin(socket);
                if (typeof requestData !== "object" || requestData === null) {
                    throw new ValidationError("Settings must be an object");
                }
                const data = requestData as Record<string, unknown>;
                const providers = Array.isArray(data.providers) ? data.providers : [];
                await Settings.set("oauthProviders", providers);
                callback({
                    ok: true,
                    msg: "Saved",
                });
                server.sendInfo(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async login(username : string, password : string) : Promise<User | null> {
        if (typeof username !== "string" || typeof password !== "string") {
            return null;
        }

        const user = await R.findOne("user", " username = ? AND active = 1 AND auth_provider = 'local' ", [
            username,
        ]) as User;

        if (user && verifyPassword(password, user.password)) {
            // Upgrade the hash to bcrypt
            if (needRehashPassword(user.password)) {
                await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
                    generatePasswordHash(password),
                    user.id,
                ]);
            }
            return user;
        }

        return null;
    }
}
