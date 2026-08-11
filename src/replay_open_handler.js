'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hashFile(filePath) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('error', reject);
		hash.on('error', reject);
		hash.on('finish', () => resolve(hash.digest('hex')));
		stream.pipe(hash);
	});
}

async function filesAreEqual(firstPath, secondPath) {
	const [firstStat, secondStat] = await Promise.all([
		fs.promises.stat(firstPath),
		fs.promises.stat(secondPath),
	]);
	if (firstStat.size !== secondStat.size) {
		return false;
	}
	const [firstHash, secondHash] = await Promise.all([
		hashFile(firstPath),
		hashFile(secondPath),
	]);
	return firstHash === secondHash;
}

class ReplayOpenHandler {
	constructor(bridge, writePath, log, confirmOverwrite) {
		this.bridge = bridge;
		this.writePath = writePath;
		this.log = log;
		this.confirmOverwrite = confirmOverwrite;
		this.pendingReplays = [];
		this.chobbyReady = false;
	}

	getReplayFiles(argv, workingDirectory) {
		return argv
			.filter(arg => typeof arg === 'string' && arg.toLowerCase().endsWith('.sdfz'))
			.map(arg => path.resolve(workingDirectory, arg));
	}

	async openArgs(argv, workingDirectory) {
		const replayFiles = this.getReplayFiles(argv, workingDirectory);
		let openedCount = 0;
		for (const replayFile of replayFiles) {
			if (await this.openFile(replayFile)) {
				openedCount++;
			}
		}
		return openedCount;
	}

	async openFile(sourcePath) {
		const source = path.resolve(sourcePath);
		const stat = await fs.promises.stat(source);
		if (!stat.isFile()) {
			throw new Error(`Replay path is not a file: ${source}`);
		}

		const demosPath = path.join(this.writePath, 'demos');
		const destination = path.join(demosPath, path.basename(source));
		await fs.promises.mkdir(demosPath, { recursive: true });

		if (source !== path.resolve(destination)) {
			let shouldCopy = true;
			try {
				if (await filesAreEqual(source, destination)) {
					shouldCopy = false;
					this.log.info(`Replay already imported with identical contents: ${destination}`);
				} else {
					if (!await this.confirmOverwrite(source, destination)) {
						return null;
					}
				}
			} catch (error) {
				if (error.code !== 'ENOENT') {
					throw error;
				}
			}

			if (shouldCopy) {
				await fs.promises.copyFile(source, destination);
				await fs.promises.rm(`${destination}.cache`, { force: true });
				this.log.info(`Imported replay: ${source} -> ${destination}`);
			}
		}

		const relativePath = path.posix.join('demos', path.basename(destination));
		this.queueReplay(relativePath);
		return relativePath;
	}

	queueReplay(relativePath) {
		if (this.chobbyReady) {
			this.bridge.send('OpenReplay', { relativePath });
			return;
		}
		this.pendingReplays.push(relativePath);
	}

	setChobbyReady() {
		this.chobbyReady = true;
		for (const relativePath of this.pendingReplays) {
			this.bridge.send('OpenReplay', { relativePath });
		}
		this.pendingReplays = [];
	}
}

module.exports = {
	ReplayOpenHandler,
	filesAreEqual,
};
