import { ENVIRONMENTS } from "./config.js";

const SYNC_ALARM = "cstraders-sync-trades";
const SYNC_PERIOD_MINUTES = 5;

// O token fica só neste navegador; o cache evita ler a página da Steam a cada rodada.
const TOKEN_CACHE_MS = 50 * 60 * 1000;

const STEAM_API = "https://api.steampowered.com";
const TRADES_PER_PAGE = 50;
// Conta nova chega com histórico útil sem martelar a Steam.
const FIRST_SYNC_MAX_PAGES = 10;
const MAX_PAGES_PER_RUN = 20;
// Cliques seguidos em "Atualizar trades" não podem virar rate limit da Steam.
const MIN_FETCH_INTERVAL_MS = 60 * 1000;

class SyncError extends Error {
	constructor(reason, extra = {}) {
		super(reason);
		Object.assign(this, extra);
	}
}

// --- Destino ------------------------------------------------------------------

function originMatchesPattern(origin, pattern) {
	const m = pattern.match(/^(\*|https?):\/\/([^/]+)\/?/);
	if (!m) return false;

	const [, scheme, hostPattern] = m;

	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}

	if (scheme !== "*" && `${scheme}:` !== parsed.protocol) return false;

	if (hostPattern === "*") return true;
	if (hostPattern.startsWith("*.")) {
		const base = hostPattern.slice(2);
		return parsed.hostname === base || parsed.hostname.endsWith(`.${base}`);
	}
	return parsed.hostname === hostPattern;
}

function environmentForOrigin(origin) {
	if (!origin) return null;
	const found = Object.entries(ENVIRONMENTS).find(([, env]) =>
		originMatchesPattern(origin, env.match),
	);
	return found ? found[0] : null;
}

// O storage guarda só o nome do ambiente: adulterá-lo não aponta o envio para outro host.
async function getApiOrigin() {
	const { environment, siteOrigin } = await chrome.storage.local.get([
		"environment",
		"siteOrigin",
	]);

	const env = environment ? ENVIRONMENTS[environment] : undefined;
	if (!env) return null;

	if (env.apiOrigin === null) {
		return originMatchesPattern(siteOrigin ?? "", env.match)
			? siteOrigin
			: null;
	}

	return env.apiOrigin;
}

// --- Sessão da Steam ----------------------------------------------------------

async function getAccessToken(expectedSteamId) {
	const cached = await chrome.storage.local.get([
		"cachedToken",
		"cachedSteamId",
		"cachedAt",
	]);

	if (
		cached.cachedToken &&
		cached.cachedAt > Date.now() - TOKEN_CACHE_MS &&
		(!expectedSteamId || expectedSteamId === cached.cachedSteamId)
	) {
		return { token: cached.cachedToken, steamId: cached.cachedSteamId };
	}

	let res;
	try {
		res = await fetch("https://steamcommunity.com", {
			credentials: "include",
			// Navegação HTML é o que faz a Steam renovar o JWT vencido.
			headers: {
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		});
	} catch {
		throw new SyncError("steam-unreachable");
	}

	if (!res.ok) throw new SyncError(`steam-http-${res.status}`);

	const html = await res.text();

	const tokenMatch = html.match(
		/data-loyalty_webapi_token="&quot;([a-zA-Z0-9_.-]+)&quot;"/,
	);
	if (!tokenMatch) {
		// Deslogado só com prova; sem ela, a Steam mudou o HTML da página.
		throw new SyncError(
			/g_steamID = false/.test(html) ? "not-logged-in" : "token-parse-failed",
		);
	}

	const token = tokenMatch[1];
	const steamId = steamIdFromToken(token);
	if (!steamId) throw new SyncError("token-parse-failed");

	if (expectedSteamId && steamId !== expectedSteamId) {
		await chrome.storage.local.set({
			status: "wrong-account",
			wrongAccountSteamId: steamId,
		});
		throw new SyncError("wrong-account", { loggedSteamId: steamId });
	}

	await chrome.storage.local.set({
		cachedToken: token,
		cachedSteamId: steamId,
		cachedAt: Date.now(),
	});

	return { token, steamId };
}

// O `sub` do JWT é o SteamID64 do dono do token.
function steamIdFromToken(token) {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const { sub } = JSON.parse(
			atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
		);
		return /^\d{17}$/.test(sub) ? sub : undefined;
	} catch {
		return undefined;
	}
}

function clearCachedToken() {
	return chrome.storage.local.remove(["cachedToken", "cachedSteamId", "cachedAt"]);
}

async function fetchTradePage(token, startAfter) {
	const params = new URLSearchParams({
		access_token: token,
		max_trades: String(TRADES_PER_PAGE),
		get_descriptions: "true",
		include_failed: "false",
	});
	if (startAfter) {
		params.set("start_after_time", String(startAfter.time));
		params.set("start_after_tradeid", startAfter.tradeId);
	}

	let res;
	try {
		res = await fetch(`${STEAM_API}/IEconService/GetTradeHistory/v1/?${params}`);
	} catch {
		throw new SyncError("steam-unreachable");
	}

	if (res.status === 401 || res.status === 403) {
		throw new SyncError("steam-auth-failed");
	}
	if (!res.ok) throw new SyncError("steam-api-failed");

	const { response } = await res.json();
	return {
		trades: response?.trades ?? [],
		descriptions: response?.descriptions ?? [],
		more: Boolean(response?.more),
	};
}

// Envia só as trades com itens recebidos e só os campos que o CsTraders usa.
function toUploadPage(steamId, page, isNew) {
	const trades = page.trades
		.filter((trade) => isNew(trade) && trade.assets_received?.length)
		.map((trade) => ({
			tradeid: trade.tradeid,
			steamid_other: trade.steamid_other,
			time_init: trade.time_init,
			status: trade.status,
			assets_received: trade.assets_received.map((asset) => ({
				assetid: asset.assetid,
				classid: asset.classid,
				instanceid: asset.instanceid,
			})),
		}));

	const usedClasses = new Set(
		trades.flatMap((trade) =>
			trade.assets_received.map((a) => `${a.classid}_${a.instanceid}`),
		),
	);

	const descriptions = page.descriptions
		.filter((d) => usedClasses.has(`${d.classid}_${d.instanceid}`))
		.map((d) => ({
			classid: d.classid,
			instanceid: d.instanceid,
			name: d.name,
			market_hash_name: d.market_hash_name,
			icon_url: d.icon_url,
			type: d.type,
			descriptions: d.descriptions,
		}));

	return { steamId, trades, descriptions };
}

// --- Envio ao CsTraders -------------------------------------------------------

async function callBackend(apiOrigin, linkToken, path, init = {}) {
	let res;
	try {
		res = await fetch(`${apiOrigin}${path}`, {
			...init,
			headers: {
				...init.headers,
				Authorization: `Bearer ${linkToken}`,
			},
		});
	} catch {
		throw new SyncError("backend-unreachable");
	}

	if (res.status === 401) {
		// Link token vencido: o site gera outro no próximo vínculo.
		await chrome.storage.local.remove("linkToken");
		await chrome.storage.local.set({ status: "needs-relink" });
		throw new SyncError("unauthorized");
	}

	if (res.status === 409) {
		const { steamId } = await res.json();
		await chrome.storage.local.set({
			status: "account-not-registered",
			unregisteredSteamId: steamId,
			steamId,
		});
		throw new SyncError("account-not-registered", { steamId });
	}

	if (!res.ok) throw new SyncError(`backend-${res.status}`);

	return res.json();
}

// Alarme e cliques simultâneos esperam a mesma rodada em vez de abrir outra.
let runningSync = null;

function syncTrades(options = {}) {
	runningSync ??= runSync(options).finally(() => {
		runningSync = null;
	});
	return runningSync;
}

async function runSync(options) {
	const { linkToken } = await chrome.storage.local.get("linkToken");
	if (!linkToken) return { ok: false, reason: "no-link-token" };

	const apiOrigin = await getApiOrigin();
	if (!apiOrigin) return { ok: false, reason: "no-api-origin" };

	try {
		// Quem pede a sincronização pode exigir uma conta; o alarme aceita a logada.
		let session = await getAccessToken(options.expectedSteamId);

		const { lastFetch } = await chrome.storage.local.get("lastFetch");
		const elapsed = Date.now() - (lastFetch?.at ?? 0);
		if (lastFetch?.steamId === session.steamId && elapsed < MIN_FETCH_INTERVAL_MS) {
			return {
				ok: true,
				steamId: session.steamId,
				stored: 0,
				throttled: true,
				retryAfterMs: MIN_FETCH_INTERVAL_MS - elapsed,
			};
		}

		const { latestTradeTime } = await callBackend(
			apiOrigin,
			linkToken,
			`/api/steam/extension/cursor?steamId=${session.steamId}`,
		);

		await chrome.storage.local.set({
			lastFetch: { steamId: session.steamId, at: Date.now() },
		});

		// `>=`: trades no mesmo segundo do cursor podem ter ficado de fora; o backend ignora repetidas.
		const isNew = (trade) =>
			latestTradeTime === null || trade.time_init >= latestTradeTime;
		const maxPages =
			latestTradeTime === null ? FIRST_SYNC_MAX_PAGES : MAX_PAGES_PER_RUN;

		let startAfter = null;
		let stored = 0;
		let sentAny = false;

		for (let pageCount = 0; pageCount < maxPages; pageCount++) {
			let page;
			try {
				page = await fetchTradePage(session.token, startAfter);
			} catch (err) {
				// O que já foi enviado vale: a Steam limita páginas seguidas, e a próxima rodada retoma do cursor.
				if (pageCount > 0) break;
				if (err.message !== "steam-auth-failed") throw err;
				// Token revogado antes do cache vencer: lê a sessão de novo uma vez.
				await clearCachedToken();
				session = await getAccessToken(options.expectedSteamId);
				page = await fetchTradePage(session.token, startAfter);
			}

			const upload = toUploadPage(session.steamId, page, isNew);
			if (upload.trades.length > 0) {
				const result = await callBackend(apiOrigin, linkToken, "/api/steam/extension/trades", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(upload),
				});
				stored += result.stored;
				sentAny = true;
			}

			const reachedCursor = page.trades.some((trade) => !isNew(trade));
			const last = page.trades.at(-1);
			if (!page.more || reachedCursor || !last) break;
			startAfter = { time: last.time_init, tradeId: last.tradeid };
		}

		// Envio vazio também conta: é por ele que o CsTraders sabe que a conta está em dia.
		if (!sentAny) {
			await callBackend(apiOrigin, linkToken, "/api/steam/extension/trades", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ steamId: session.steamId, trades: [], descriptions: [] }),
			});
		}

		await chrome.storage.local.set({
			status: "connected",
			steamId: session.steamId,
			lastSyncAt: Date.now(),
			unregisteredSteamId: null,
		});
		return { ok: true, steamId: session.steamId, stored };
	} catch (err) {
		const reason = err instanceof SyncError ? err.message : "sync-failed";
		if (reason === "not-logged-in") {
			await chrome.storage.local.set({ status: "steam-logged-out" });
		}
		return {
			ok: false,
			reason,
			loggedSteamId: err?.loggedSteamId,
			steamId: err?.steamId,
		};
	}
}

// --- Mensagens do site --------------------------------------------------------

chrome.runtime.onMessageExternal.addListener(
	(message, sender, sendResponse) => {
		if (!message || typeof message !== "object") {
			sendResponse({ ok: false });
			return false;
		}

		// `sender.origin` vem do Chrome: a página não escolhe o destino.
		const environment = environmentForOrigin(sender.origin);
		if (!environment) {
			sendResponse({ ok: false, reason: "origin-not-allowed" });
			return false;
		}

		// Sempre um link token novo: reusar o guardado poderia mandar as trades a outra loja.
		if (message.type === "LINK" && typeof message.linkToken === "string") {
			chrome.storage.local
				.set({
					linkToken: message.linkToken,
					status: "linking",
					environment,
					siteOrigin: sender.origin,
				})
				.then(() => syncTrades({ expectedSteamId: message.expectedSteamId }))
				.then((result) => sendResponse(result))
				.catch(() => sendResponse({ ok: false }));
			return true;
		}

		if (message.type === "STATUS") {
			chrome.storage.local
				.get(["status", "steamId", "lastSyncAt", "unregisteredSteamId"])
				.then((data) =>
					sendResponse({
						ok: data.status === "connected",
						status: data.status ?? "disconnected",
						steamId: data.steamId ?? null,
						lastSyncAt: data.lastSyncAt ?? null,
						unregisteredSteamId: data.unregisteredSteamId ?? null,
					}),
				)
				.catch(() => sendResponse({ ok: false }));
			return true;
		}

		sendResponse({ ok: false });
		return false;
	},
);

// --- Agenda -------------------------------------------------------------------

function syncInBackground() {
	syncTrades().catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === SYNC_ALARM) syncInBackground();
});

function ensureAlarm() {
	chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => {
	ensureAlarm();
	syncInBackground();
});

chrome.runtime.onStartup.addListener(() => {
	ensureAlarm();
	syncInBackground();
});
