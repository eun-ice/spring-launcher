'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { describe, test } = require('node:test');

const {
	LINUX_DESKTOP_FILE,
	MIME_TYPE,
	ReplayFileAssociation,
	getHandlerPath,
} = require('./replay_file_association');

describe('ReplayFileAssociation', () => {
	test('uses the stable portable or AppImage path when available', () => {
		assert.equal(getHandlerPath({ PORTABLE_EXECUTABLE_FILE: 'C:\\BAR.exe' }, '/tmp/electron'), 'C:\\BAR.exe');
		assert.equal(getHandlerPath({ APPIMAGE: '/games/BAR.AppImage' }, '/tmp/electron'), '/games/BAR.AppImage');
		assert.equal(getHandlerPath({}, '/opt/BAR/spring-launcher'), '/opt/BAR/spring-launcher');
	});

	test('registers a Linux desktop handler and makes it the MIME default', async () => {
		const writes = new Map();
		const calls = [];
		const association = new ReplayFileAssociation({
			platform: 'linux',
			executablePath: '/games/BAR.AppImage',
			homePath: '/home/test',
			fs: {
				mkdir: async () => {},
				writeFile: async (filePath, contents) => writes.set(filePath, contents),
				rm: async () => {},
			},
			execFile: async (command, args) => {
				calls.push([command, args]);
				return { stdout: '' };
			},
		});

		await association.register();

		const desktopPath = path.join('/home/test/.local/share/applications', LINUX_DESKTOP_FILE);
		assert.match(writes.get(desktopPath), /Exec="\/games\/BAR\.AppImage" %f/);
		assert.deepEqual(calls.at(-1), [
			'xdg-mime', ['default', LINUX_DESKTOP_FILE, MIME_TYPE],
		]);
	});

	test('recognizes only the current Linux executable as the default handler', async () => {
		let desktopEntry;
		const association = new ReplayFileAssociation({
			platform: 'linux',
			executablePath: '/games/BAR.AppImage',
			homePath: '/home/test',
			fs: {
				readFile: async () => desktopEntry,
			},
			execFile: async () => ({ stdout: `${LINUX_DESKTOP_FILE}\n` }),
		});
		desktopEntry = association.getLinuxDesktopEntry();
		assert.equal(await association.isRegistered(), true);
		desktopEntry = desktopEntry.replace('/games/BAR.AppImage', '/old/BAR.AppImage');
		assert.equal(await association.isRegistered(), false);
	});

	test('writes the Windows Open With and Default Apps registrations', async () => {
		const calls = [];
		const association = new ReplayFileAssociation({
			platform: 'win32',
			executablePath: 'C:\\Games\\BAR\\spring-launcher.exe',
			execFile: async (command, args) => {
				calls.push([command, args]);
				if (args[0] === 'query') {
					const error = new Error('not found');
					throw error;
				}
				return { stdout: '' };
			},
		});

		await association.register();

		assert.ok(calls.some(([, args]) =>
			args.includes('HKCU\\Software\\Classes\\Applications\\spring-launcher.exe\\SupportedTypes') &&
			args.includes('.sdfz')
		));
		assert.ok(calls.some(([, args]) =>
			args.includes('HKCU\\Software\\RegisteredApplications') &&
			args.includes('BAR Spring Launcher') &&
			args.includes('Software\\BAR Spring Launcher\\Capabilities')
		));
		assert.ok(calls.some(([, args]) =>
			args.includes('"C:\\Games\\BAR\\spring-launcher.exe" "%1"')
		));
	});

	test('removes the Linux handler files when disabled', async () => {
		const removed = [];
		const writes = new Map();
		const association = new ReplayFileAssociation({
			platform: 'linux',
			executablePath: '/games/BAR.AppImage',
			homePath: '/home/test',
			fs: {
				rm: async filePath => removed.push(filePath),
				readFile: async filePath => {
					if (filePath === '/home/test/.config/mimeapps.list') {
						return `[Default Applications]\n${MIME_TYPE}=${LINUX_DESKTOP_FILE};other.desktop;\n`;
					}
					const error = new Error('not found');
					error.code = 'ENOENT';
					throw error;
				},
				writeFile: async (filePath, contents) => writes.set(filePath, contents),
			},
			execFile: async () => ({ stdout: '' }),
		});

		await association.unregister();

		assert.ok(removed.includes('/home/test/.local/share/applications/spring-launcher-sdfz.desktop'));
		assert.ok(removed.includes('/home/test/.local/share/mime/packages/spring-launcher-sdfz.xml'));
		assert.equal(
			writes.get('/home/test/.config/mimeapps.list'),
			`[Default Applications]\n${MIME_TYPE}=other.desktop;\n`
		);
	});
});
