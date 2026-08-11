'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { afterEach, beforeEach, describe, test } = require('node:test');

const { ReplayOpenHandler } = require('./replay_open_handler');

describe('ReplayOpenHandler', () => {
	let tempPath;
	let writePath;
	let bridgeCalls;
	let overwriteCalls;
	let overwriteResponse;
	let handler;

	beforeEach(async () => {
		tempPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'spring-launcher-replay-'));
		writePath = path.join(tempPath, 'data');
		bridgeCalls = [];
		overwriteCalls = [];
		overwriteResponse = false;
		handler = new ReplayOpenHandler(
			{ send: (...args) => bridgeCalls.push(args) },
			writePath,
			{ info: () => {} },
			async (...args) => {
				overwriteCalls.push(args);
				return overwriteResponse;
			}
		);
	});

	afterEach(async () => {
		await fs.promises.rm(tempPath, { recursive: true, force: true });
	});

	test('reuses identical contents without copying or deleting the cache', async () => {
		const source = path.join(tempPath, '2026-08-11_test.sdfz');
		const destination = path.join(writePath, 'demos', path.basename(source));
		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		await fs.promises.writeFile(source, 'same replay');
		await fs.promises.writeFile(destination, 'same replay');
		await fs.promises.writeFile(`${destination}.cache`, 'valid cache');

		assert.equal(await handler.openFile(source), 'demos/2026-08-11_test.sdfz');
		assert.deepEqual(overwriteCalls, []);
		assert.equal(await fs.promises.readFile(`${destination}.cache`, 'utf8'), 'valid cache');
	});

	test('asks before overwriting different contents and removes the stale cache', async () => {
		const source = path.join(tempPath, '2026-08-11_test.sdfz');
		const destination = path.join(writePath, 'demos', path.basename(source));
		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		await fs.promises.writeFile(source, 'new replay');
		await fs.promises.writeFile(destination, 'old replay');
		await fs.promises.writeFile(`${destination}.cache`, 'stale cache');
		overwriteResponse = true;

		assert.equal(await handler.openFile(source), 'demos/2026-08-11_test.sdfz');
		assert.deepEqual(overwriteCalls, [[source, destination]]);
		assert.equal(await fs.promises.readFile(destination, 'utf8'), 'new replay');
		await assert.rejects(fs.promises.stat(`${destination}.cache`), { code: 'ENOENT' });
	});

	test('leaves a different existing replay untouched when overwrite is canceled', async () => {
		const source = path.join(tempPath, '2026-08-11_test.sdfz');
		const destination = path.join(writePath, 'demos', path.basename(source));
		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		await fs.promises.writeFile(source, 'new replay');
		await fs.promises.writeFile(destination, 'old replay');

		assert.equal(await handler.openFile(source), null);
		assert.equal(await fs.promises.readFile(destination, 'utf8'), 'old replay');
		assert.deepEqual(bridgeCalls, []);
	});

	test('queues the replay until Chobby reports that its handler is ready', async () => {
		const source = path.join(tempPath, '2026-08-11_test.sdfz');
		await fs.promises.writeFile(source, 'replay');

		await handler.openFile(source);
		assert.deepEqual(bridgeCalls, []);

		handler.setChobbyReady();
		assert.deepEqual(bridgeCalls, [[
			'OpenReplay',
			{ relativePath: 'demos/2026-08-11_test.sdfz' },
		]]);
	});

	test('extracts sdfz paths case-insensitively from launcher arguments', () => {
		assert.deepEqual(
			handler.getReplayFiles(['launcher', 'one.SDFZ', '--dev', 'two.txt'], '/downloads'),
			[path.resolve('/downloads/one.SDFZ')]
		);
	});
});
