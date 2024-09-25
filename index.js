const http = require("http");
const fs = require("fs");
const path = require("path");

let clientId = "d4e046e975ac40888dea436709db538b";
let port = 42069;
let redirectUri = `http://localhost:${port}/callback`;
let refreshLocation = path.join(__dirname, "refresh");
const scopes = "playlist-read-private playlist-modify-private playlist-modify-public";

const allArgs = [
    { name: "id", long: "id", short: "id", description: "The URL/ID of the playlist" },
    { name: "name", long: "name", short: "n", description: "New playlist name" },
    { name: "description", long: "description", short: "d", description: "New playlist description" },
    { name: "public", long: "public", short: "p", description: "Make playlist public" },
    { name: "overwrite", long: "overwrite", short: "o", description: "Overwrite current playlist" },
    { name: "clientId", long: "client-id", short: "cid", description: "Client ID to use" },
    { name: "port", long: "port", short: "port", description: `Port to use when authorizing (default: ${port})` },
    { name: "redirectUri", long: "redirect-uri", short: "url", description: `Redirect URI to use when authorizing (default: ${redirectUri})` },
    { name: "noRefresh", long: "no-refresh", short: "nr", description: "Don't save refresh token for later" },
    { name: "refreshLocation", long: "refresh", short: "location", description: "Where to save refresh token" },
];

const args = Object.fromEntries(process.argv.slice(2).map((value, index, array) => {
    const keyLong = value.match(/^--(.+)/);
    const keyShort = !keyLong ? value.match(/^-(.+)/) : null;
    const argValue = !array[index + 1]?.match(/^-{1,2}(.+)/) ? array[index + 1] || null : null;

    if (!keyLong && !keyShort) return null;
    const argInfo = allArgs.find(i => keyLong ? i.long === keyLong[1] : keyShort ? i.short === keyShort[1] : false);
    if (!argInfo) return null;
    return [argInfo.name || argInfo.long || argInfo.short, argValue];
}).filter(i => i !== null));

let token;

(async () => {
    clientId = args.clientId || clientId;
    port = args.port || port;
    redirectUri = args.redirectUri || redirectUri;
    refreshLocation = args.refreshLocation || refreshLocation;

    if (args.help || !args.id) return help();

    token = await authorize().then(i => i.access_token);
    console.log("Authorized, getting user");
    const user = await getUser();
    console.log(`Hi ${user.display_name}, getting playlist`);
    const playlist = await getPlaylist(args.id);
    console.log(`Got ${playlist.allTracks.length} tracks, shuffling them around`);
    const newPlaylist = args.overwrite === undefined ? await createPlaylist(user.id, args.name || `${playlist.name} (Shuffled)`, args.description || undefined) : playlist;
    const shuffled = [...playlist.allTracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    await overwritePlaylist(newPlaylist.id, shuffled);    
    console.log(`Done, shuffled playlist: ${newPlaylist.uri} - ${newPlaylist.name}`);
})();


function help() {
    console.log("Spotify-Jumbler");
    console.log("");
    console.log(allArgs.map(i => `-${i.short} --${i.long} : ${i.description}`).join("\n"));
}

function getUser() {
    return new Promise(async (resolve, reject) => {
        const user = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${token}` } }).then(i => i.json());
        resolve(user);
    });
}

function overwritePlaylist(id, tracks) {
    return new Promise(async (resolve, reject) => {
        await fetch(`https://api.spotify.com/v1/playlists/${id}/tracks`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                uris: []
            })
        }).then(i => i.json());

        for (let i = 0; i < Math.ceil(tracks.length / 100); i++) {
            await fetch(`https://api.spotify.com/v1/playlists/${id}/tracks`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    position: i * 100,
                    uris: tracks.slice(i * 100, (i + 1) * 100).map(i => i.track.uri)
                })
            }).then(i => i.json());
        }
        resolve();
    });
}

function createPlaylist(userId, name, description) {
    return new Promise(async (resolve, reject) => {
        const playlist = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name,
                description,
                public: args.public === undefined ? false : true
            })
        }).then(i => i.json());
        resolve(playlist);
    });
}

function getPlaylist(id) {
    return new Promise(async (resolve, reject) => {
        id = id.replace(/.*\//, "").replace(/\?.*/, "");
        const playlist = await fetch(`https://api.spotify.com/v1/playlists/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(i => i.json());
        playlist.allTracks = playlist.tracks.items;
        if (playlist.tracks.next) console.log(`Getting ${playlist.tracks.total} tracks, this can take a while if there is a lot`);
        await (async function getTracks(next = playlist.tracks.next) {
            if (!next) return;
            const tracksRes = await fetch(next, { headers: { Authorization: `Bearer ${token}` } }).then(i => i.json());
            if (tracksRes.items) playlist.allTracks.push(...tracksRes.items);
            if (tracksRes.next) return await getTracks(tracksRes.next);
        })();
        resolve(playlist);
    });
}

function genCodeChallenge() {
    return new Promise(async resolve => {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const values = crypto.getRandomValues(Buffer.alloc(64));
        const codeVerifier = values.reduce((acc, x) => acc + chars[x % chars.length], "");
    
        const hashed = await crypto.subtle.digest("SHA-256", Buffer.from(codeVerifier));
    
        const codeChallenge = Buffer.from(hashed).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

        resolve({ codeVerifier, hashed, codeChallenge });
    });
}

function authorize() {
    return new Promise(async (resolve, reject) => {
        let resolved = false;

        if (fs.existsSync(refreshLocation)) {
            console.log("Authorizing using refresh token");
            await fetch(`https://accounts.spotify.com/api/token?client_id=${encodeURIComponent(clientId)}&grant_type=refresh_token&refresh_token=${encodeURIComponent(fs.readFileSync(refreshLocation))}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            }).then(i => i.json()).then(token => {
                if (token.error || !token.access_token) {
                    console.log("Failed to get access token!", token.error || token);
                }
                if (!args.noRefresh && token.refresh_token) fs.writeFile("./refresh", token.refresh_token, (err) => { err ? console.log("Failed to save refresh token!") : null, err });
                resolved = true;
                resolve(token);
            }).catch(err => {
                console.log("Failed to get access token!", err);
            });
        }

        if (resolved) return;
        console.log("Creating temporary server to authorize with Spotify");
        const server = http.createServer();

        const timeout = setTimeout(() => {
            server.close();
            reject("Timed out");
        }, 2 * 60 * 1000);

        let codeVerifier, codeChallenge;
        server.on("request", async (req, res) => {
            const path = req.url.split("?")[0];
            const query = Object.fromEntries(req.url.split("?")[1]?.split("&").map(i => i.split("=")) || []);

            if (path === "/") {
                const generatedCodeChallenge = await genCodeChallenge();
                codeChallenge = generatedCodeChallenge.codeChallenge;
                codeVerifier = generatedCodeChallenge.codeVerifier;
                res.statusCode = 302;
                res.setHeader("Location", `https://accounts.spotify.com/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scopes)}&code_challenge_method=S256&code_challenge=${encodeURIComponent(codeChallenge)}&redirect_uri=${encodeURIComponent(redirectUri)}`);
                res.end();
            } else
            if (path === "/callback") {
                res.setHeader("Content-Type", "text/html");

                if (!codeVerifier) return res.end("No code verifier, <a href=\"/\">you must first authorize here</a>");

                if (query.error || !query.code) {
                    const errorMessage = `Could not authorize, ${query.error || "no error message"}. <a href="/">Click to try again</a>`;
                    res.end(errorMessage);
                    console.log(errorMessage);
                    return;
                }

                res.end(`Authorized, you can close this tab<script>window.close()</script>`);
                console.log("Got authorization code, closing server and getting access token");
                server.close();

                await fetch(`https://accounts.spotify.com/api/token?client_id=${encodeURIComponent(clientId)}&grant_type=authorization_code&code=${encodeURIComponent(query.code)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_verifier=${encodeURIComponent(codeVerifier)}`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded"
                    }
                }).then(i => i.json()).then(token => {
                    if (token.error || !token.access_token) {
                        console.log("Failed to get access token!", token.error || token);
                        return reject();
                    }
                    clearTimeout(timeout);
                    if (!args.noRefresh && token.refresh_token) fs.writeFile(refreshLocation, token.refresh_token, (err) => { err ? console.log("Failed to save refresh token!", err) : null });
                    resolved = true;
                    resolve(token);
                }).catch(err => {
                    console.log("Failed to get access token!", err);
                    reject();
                });
            } else {
                res.statusCode = 404;
                res.end();
            }
        });

        server.listen(port, () => console.log(`Please go to http://localhost:${port} to authorize with Spotify!`));
    });
}