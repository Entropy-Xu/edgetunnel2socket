#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LISTEN = '127.0.0.1';
const DEFAULT_PORT = 1080;
const DEFAULT_OUT = 'sing-box.generated.json';
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';

function printUsage() {
	console.error(`Usage:
  node tools/generate-singbox-config.mjs --sub <subscription-url> [--listen 127.0.0.1] [--port 1080] [--out sing-box.generated.json]
  node tools/generate-singbox-config.mjs --input <links.txt> [--listen 127.0.0.1] [--port 1080] [--out sing-box.generated.json]

Options:
  --sub      Fetch subscription content from URL
  --input    Read subscription content from a local text file
  --listen   Local SOCKS listen address, default ${DEFAULT_LISTEN}
  --port     Local SOCKS listen port, default ${DEFAULT_PORT}
  --out      Output sing-box config path, default ${DEFAULT_OUT}
  --help     Show this help`);
}

function parseArgs(argv) {
	const args = {
		listen: DEFAULT_LISTEN,
		port: DEFAULT_PORT,
		out: DEFAULT_OUT,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			args.help = true;
			continue;
		}
		if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
		i += 1;

		if (key === 'sub') args.sub = next;
		else if (key === 'input') args.input = next;
		else if (key === 'listen') args.listen = next;
		else if (key === 'port') args.port = parsePort(next);
		else if (key === 'out') args.out = next;
		else throw new Error(`Unknown option: --${key}`);
	}

	if (args.help) return args;
	if (!args.sub && !args.input) throw new Error('Provide one input source: --sub or --input');
	if (args.sub && args.input) throw new Error('Use only one input source: --sub or --input');

	return args;
}

function parsePort(value) {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${value}`);
	}
	return port;
}

async function readSubscription(args) {
	if (args.sub) {
		if (typeof fetch !== 'function') {
			throw new Error('This script needs Node.js 18+ for fetch when --sub is used');
		}
		const response = await fetch(args.sub, {
			headers: {
				'User-Agent': 'edgetunnel-sing-box-adapter/1.0',
				'Accept': 'text/plain, */*',
			},
		});
		if (!response.ok) {
			throw new Error(`Subscription request failed: ${response.status} ${response.statusText}`);
		}
		return response.text();
	}

	return readFile(args.input, 'utf8');
}

function normalizeSubscriptionContent(content) {
	const text = stripBom(String(content || '')).trim();
	const compact = text.replace(/\s+/g, '');
	const decoded = tryDecodeBase64(compact);

	if (!hasProtocolLink(text) && decoded && hasProtocolLink(decoded)) {
		return {
			content: decoded.trim(),
			decodedBase64: true,
		};
	}

	return {
		content: text,
		decodedBase64: false,
	};
}

function stripBom(value) {
	return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function hasProtocolLink(value) {
	return /[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function tryDecodeBase64(value) {
	if (!value || value.length < 8) return null;
	if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return null;

	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	try {
		const decoded = Buffer.from(padded, 'base64').toString('utf8');
		if (decoded.includes('\u0000')) return null;
		return decoded;
	} catch {
		return null;
	}
}

function extractLinks(content) {
	const links = [];
	const ignoredProtocols = new Map();
	const seen = new Set();

	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const matches = trimmed.match(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi) || [];
		for (const rawLink of matches) {
			const link = rawLink.trim();
			const protocol = link.slice(0, link.indexOf(':')).toLowerCase();
			if (protocol !== 'vless') {
				ignoredProtocols.set(protocol, (ignoredProtocols.get(protocol) || 0) + 1);
				continue;
			}
			if (!seen.has(link)) {
				seen.add(link);
				links.push(link);
			}
		}
	}

	return {
		vlessLinks: links,
		ignoredProtocols,
	};
}

function parseVlessLink(link, index) {
	let url;
	try {
		url = new URL(link);
	} catch (error) {
		throw new Error(`Invalid VLESS link at #${index + 1}: ${error.message}`);
	}

	if (url.protocol !== 'vless:') {
		throw new Error(`Unsupported link protocol at #${index + 1}: ${url.protocol}`);
	}

	const uuid = safeDecode(url.username);
	if (!uuid) throw new Error(`Missing VLESS uuid at #${index + 1}`);

	const server = safeDecode(url.hostname);
	if (!server) throw new Error(`Missing VLESS server at #${index + 1}`);

	const search = url.searchParams;
	const security = lowerOrDefault(search.get('security'), 'none');
	const type = lowerOrDefault(search.get('type'), 'tcp');
	const serverPort = url.port ? parsePort(url.port) : (security === 'tls' ? 443 : 80);
	const host = firstValue(search, ['host', 'authority']);
	const sni = firstValue(search, ['sni', 'peer']);
	const path = firstValue(search, ['path', 'serviceName']) || '/';
	const fp = search.get('fp') || search.get('fingerprint') || 'chrome';
	const remark = parseRemark(url.hash, `${server}:${serverPort}`);

	return {
		uuid,
		server,
		server_port: serverPort,
		security,
		type,
		host,
		sni,
		path,
		fp,
		remark,
		raw: link,
	};
}

function lowerOrDefault(value, fallback) {
	return value ? value.toLowerCase() : fallback;
}

function firstValue(search, names) {
	for (const name of names) {
		const value = search.get(name);
		if (value) return value;
	}
	return '';
}

function parseRemark(hash, fallback) {
	if (!hash) return fallback;
	const encoded = hash.startsWith('#') ? hash.slice(1) : hash;
	return safeDecode(encoded.replace(/\+/g, '%20')) || fallback;
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function buildSingBoxConfig(nodes, options) {
	const tags = createUniqueTags(nodes);
	const outbounds = nodes.map((node, index) => buildVlessOutbound(node, tags[index]));
	const routeFinal = outbounds.length === 1 ? outbounds[0].tag : 'auto-vless';

	if (outbounds.length > 1) {
		outbounds.push({
			type: 'urltest',
			tag: routeFinal,
			outbounds: tags,
			url: DEFAULT_TEST_URL,
			interval: '10m',
		});
	}

	return {
		log: {
			level: 'info',
			timestamp: true,
		},
		inbounds: [
			{
				type: 'socks',
				tag: 'socks-in',
				listen: options.listen,
				listen_port: options.port,
				sniff: true,
			},
		],
		outbounds,
		route: {
			final: routeFinal,
		},
	};
}

function buildVlessOutbound(node, tag) {
	const outbound = {
		type: 'vless',
		tag,
		server: node.server,
		server_port: node.server_port,
		uuid: node.uuid,
	};

	if (node.security === 'tls') {
		outbound.tls = {
			enabled: true,
			server_name: node.sni || node.host || node.server,
			utls: {
				enabled: true,
				fingerprint: node.fp || 'chrome',
			},
		};
	}

	if (node.type === 'ws' || node.type === 'websocket') {
		outbound.transport = {
			type: 'ws',
			path: node.path || '/',
			headers: {
				Host: node.host || node.sni || node.server,
			},
		};
	}

	return outbound;
}

function createUniqueTags(nodes) {
	const used = new Map();
	return nodes.map((node, index) => {
		const base = sanitizeTag(node.remark || `${node.server}:${node.server_port}` || `vless-${index + 1}`) || `vless-${index + 1}`;
		const count = used.get(base) || 0;
		used.set(base, count + 1);
		return count === 0 ? base : `${base}-${count + 1}`;
	});
}

function sanitizeTag(value) {
	return value
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
}

function describeIgnoredProtocols(ignoredProtocols) {
	return Array.from(ignoredProtocols.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([protocol, count]) => `${protocol}=${count}`)
		.join(', ');
}

export {
	buildSingBoxConfig,
	extractLinks,
	normalizeSubscriptionContent,
	parseArgs,
	parseVlessLink,
};

async function main() {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.help) {
			printUsage();
			return;
		}

		const source = await readSubscription(args);
		const normalized = normalizeSubscriptionContent(source);
		const extracted = extractLinks(normalized.content);
		if (extracted.ignoredProtocols.size > 0) {
			console.warn(`[提示] 已忽略非 VLESS 链接: ${describeIgnoredProtocols(extracted.ignoredProtocols)}`);
		}
		if (extracted.vlessLinks.length === 0) {
			throw new Error('No vless:// links found in subscription content');
		}

		const nodes = extracted.vlessLinks.map(parseVlessLink);
		const config = buildSingBoxConfig(nodes, args);
		await writeFile(args.out, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

		console.error(`[完成] 读取 ${nodes.length} 个 VLESS 节点，生成 ${args.out}`);
		if (normalized.decodedBase64) console.error('[提示] 输入内容已按 base64 订阅自动解码');
	} catch (error) {
		console.error(`[错误] ${error.message}`);
		process.exitCode = 1;
	}
}

const currentFile = fileURLToPath(import.meta.url);
if (basename(process.argv[1] || '') === basename(currentFile)) {
	await main();
}
