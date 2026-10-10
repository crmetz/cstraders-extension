#!/usr/bin/env node
// Gera o pacote da Chrome Web Store a partir da raiz deste repo.
//
// A pasta serve dois destinos com exigências opostas. Em dev ela é carregada
// sem compactação e precisa de `key` (ID fixo, casando com
// VITE_STEAM_EXTENSION_ID do .env) e de `localhost` nas permissões. Na Store a
// `key` é ignorada — quem manda é a chave da conta de publicação — e
// `localhost` em `host_permissions` é justamente o tipo de coisa que trava a
// revisão.
//
// Em vez de manter dois manifests fora de sincronia, este script parte do
// manifest de dev e remove o que é só de dev.
//
// Uso: node scripts/build-release.mjs [--out <dir>]

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(HERE, "..");

/** Arquivos que entram no pacote. Lista explícita: um zip com `key.pem` dentro
 *  publicaria a chave privada da extensão. */
const SHIPPED_FILES = [
	"manifest.json",
	"config.js",
	"background.js",
	"icons/icon-16.png",
	"icons/icon-32.png",
	"icons/icon-48.png",
	"icons/icon-128.png",
];

/** Padrões de dev que não podem chegar à Store. */
const isDevOnlyMatch = (pattern) => pattern.includes("localhost");

/**
 * `config.js` e o manifest declaram as mesmas origens em lugares diferentes: o
 * mapa de ambientes decide para onde o token vai, `externally_connectable`
 * decide quem pode pedir. Divergir significa um ambiente que ninguém consegue
 * ativar, ou uma origem que fala com a extensão sem destino configurado —
 * ambos silenciosos em runtime. Melhor quebrar o build.
 */
function assertConfigMatchesManifest(environments, manifestMatches, label) {
	const configMatches = Object.values(environments).map((env) => env.match);

	const missingInManifest = configMatches.filter(
		(m) => !manifestMatches.includes(m),
	);
	if (missingInManifest.length > 0) {
		throw new Error(
			`config.js (${label}) declara origens fora de externally_connectable: ${missingInManifest.join(", ")}`,
		);
	}

	const missingInConfig = manifestMatches.filter(
		(m) => !configMatches.includes(m),
	);
	if (missingInConfig.length > 0) {
		throw new Error(
			`externally_connectable (${label}) tem origens sem ambiente em config.js: ${missingInConfig.join(", ")}`,
		);
	}
}

/**
 * Remove os ambientes de dev do `config.js` reescrevendo o literal. Sem bundler
 * a alternativa seria um segundo arquivo — que sairia de sincronia.
 */
function buildStoreConfig(source, devOnlyNames) {
	let out = source;
	for (const name of devOnlyNames) {
		const block = new RegExp(`\n\t${name}: \{[^}]*\},`, "m");
		if (!block.test(out)) {
			throw new Error(
				`não achei o bloco do ambiente "${name}" em config.js para remover.`,
			);
		}
		out = out.replace(block, "");
	}
	return out;
}

function buildStoreManifest(devManifest) {
	const manifest = structuredClone(devManifest);

	// A Store atribui o ID pela chave da conta de publicação; `key` aqui só
	// confundiria (e fixaria um ID que não é o publicado).
	delete manifest.key;

	manifest.host_permissions = manifest.host_permissions.filter(
		(p) => !isDevOnlyMatch(p),
	);
	manifest.externally_connectable = {
		...manifest.externally_connectable,
		matches: manifest.externally_connectable.matches.filter(
			(p) => !isDevOnlyMatch(p),
		),
	};

	return manifest;
}

async function zipDir(dir, zipPath) {
	try {
		await execFileAsync("zip", ["-r", "-q", zipPath, "."], { cwd: dir });
		return "zip";
	} catch {
		// Sem Compress-Archive: no PowerShell 5.1 ele grava `icons\x.png`, que fora
		// do Windows não vira pasta e a Store não acha o ícone.
		const script = [
			"Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem",
			`$dir = '${dir}'`,
			`$zip = [IO.Compression.ZipFile]::Open('${zipPath}', 'Create')`,
			"Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object {",
			"  $name = $_.FullName.Substring($dir.Length + 1).Replace('\\', '/')",
			"  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name)",
			"}",
			"$zip.Dispose()",
		].join("\n");
		await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
		return "System.IO.Compression";
	}
}

async function main() {
	const outFlag = process.argv.indexOf("--out");
	const outDir =
		outFlag !== -1 && process.argv[outFlag + 1]
			? resolve(process.argv[outFlag + 1])
			: join(EXT_DIR, "dist");

	const stageDir = join(outDir, "cstraders-steam-sync");
	await rm(outDir, { recursive: true, force: true });
	await mkdir(stageDir, { recursive: true });

	const devManifest = JSON.parse(
		await readFile(join(EXT_DIR, "manifest.json"), "utf8"),
	);
	const storeManifest = buildStoreManifest(devManifest);

	if (storeManifest.externally_connectable.matches.length === 0) {
		throw new Error(
			"externally_connectable ficou vazio: nenhuma origem de produção no manifest.",
		);
	}

	const configPath = join(EXT_DIR, "config.js");
	const configSource = await readFile(configPath, "utf8");
	const { ENVIRONMENTS, DEV_ONLY_ENVIRONMENTS } = await import(
		pathToFileURL(configPath).href
	);

	assertConfigMatchesManifest(
		ENVIRONMENTS,
		devManifest.externally_connectable.matches,
		"dev",
	);

	const storeConfigSource = buildStoreConfig(configSource, DEV_ONLY_ENVIRONMENTS);
	const storeEnvironments = Object.fromEntries(
		Object.entries(ENVIRONMENTS).filter(
			([name]) => !DEV_ONLY_ENVIRONMENTS.includes(name),
		),
	);

	if (Object.keys(storeEnvironments).length === 0) {
		throw new Error("config.js ficou sem ambiente de produção após remover os de dev.");
	}

	assertConfigMatchesManifest(
		storeEnvironments,
		storeManifest.externally_connectable.matches,
		"store",
	);

	for (const file of SHIPPED_FILES) {
		if (file === "manifest.json" || file === "config.js") continue;
		await mkdir(dirname(join(stageDir, file)), { recursive: true });
		await copyFile(join(EXT_DIR, file), join(stageDir, file));
	}
	await writeFile(join(stageDir, "config.js"), storeConfigSource);
	await writeFile(
		join(stageDir, "manifest.json"),
		`${JSON.stringify(storeManifest, null, "\t")}\n`,
	);

	const zipPath = join(outDir, `cstraders-steam-sync-v${storeManifest.version}.zip`);
	const tool = await zipDir(stageDir, zipPath);

	process.stdout.write(
		[
			`Pacote da Store: ${zipPath}  (via ${tool})`,
			`  versão              ${storeManifest.version}`,
			`  key removida        ${devManifest.key ? "sim" : "n/a"}`,
			`  host_permissions    ${storeManifest.host_permissions.join(", ")}`,
			`  externally_conn.    ${storeManifest.externally_connectable.matches.join(", ")}`,
			`  ambientes           ${Object.keys(storeEnvironments).join(", ")}`,
			"",
			"Depois de publicar, copie o ID atribuído pela Store para a variable",
			"STEAM_EXTENSION_ID do GitHub (Settings -> Secrets and variables -> Actions).",
			"",
		].join("\n"),
	);
}

main().catch((err) => {
	process.stderr.write(`${err.message}\n`);
	process.exit(1);
});
