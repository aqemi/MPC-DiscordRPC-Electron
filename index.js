const log = require('fancy-log');

log.info('INFO: Loading...');

[`SIGINT`, `SIGUSR1`, `SIGUSR2`, `SIGTERM`].forEach(eventType => {
	process.on(eventType, shutdown);
});

const axios = require('axios').default,
	FormData = require('form-data'),
	{ Client } = require('@xhayper/discord-rpc'),
	updatePresence = require('./core'),
	events = require('events'),
	sharp = require('sharp'),
	config = require('./config'),
	// clientId = '427863248734388224';
	clientId = '1108520115466678332';

let mediaEmitter = new events.EventEmitter(),
	active = false,
	discordRPCLoop,
	mpcServerLoop,
	snapshotLoop,
	snapshot,
	rpc;

// Checks if port set in config.js is valid.
if (isNaN(config.port)) {
	throw new Error("Port is empty or invalid! Please set a valid port number in 'config.js' file.");
}

const uri = `http://127.0.0.1:${config.port}/variables.html`;

log.info('INFO: Fully ready. Trying to connect to Discord client...');

// When it succesfully connects to MPC Web Interface, it begins checking MPC
// every 5 seconds, getting its playback data and sending it to Discord Rich Presence
// through updatePresence() function from core.js.
mediaEmitter.on('CONNECTED', res => {
	clearInterval(mpcServerLoop);
	mpcServerLoop = setInterval(checkMPCEndpoint, 5000);
	if (snapshotLoop?._onTimeout !== uploadSnapshot) {
		uploadSnapshot();
		clearInterval(snapshotLoop);
		snapshotLoop = setInterval(uploadSnapshot, 120_000);
	}
	let forceUpdate = false;
	if (!active) {
		log.info(`INFO: Connected to ${res.headers.server}`);
		forceUpdate = true;
	}
	active = updatePresence({ ...res, snapshot }, rpc, forceUpdate);
});

// When connection to MPC fails it attempts to connect
// to MPC again every 15 seconds.
mediaEmitter.on('CONN_ERROR', code => {
	log.error(
		`ERROR: Unable to connect to Media Player Classic on port ${config.port}. ` +
			`Make sure MPC is running, Web Interface is enabled and the port set in 'config.js' file is correct.\n` +
			code
	);
	// If MPC was previously connected (ie. MPC gets closed while script is running)
	// the whole process is killed and restarted by Forever in order to clean MPC Rich Presence
	// from user's profile, as destroyRPC() apparently can't do so.
	if (active) {
		destroyRPC().catch(err => log.error('Failed to destroy RPC', err));
		// log.warn('WARN: Killing process to clean Rich Presence from your profile...');
		// process.exit(0);
	}
	clearInterval(snapshotLoop);
	if (mpcServerLoop._onTimeout !== checkMPCEndpoint) {
		clearInterval(mpcServerLoop);
		mpcServerLoop = setInterval(checkMPCEndpoint, 15000);
	}
});

// If RPC successfully connects to Discord client,
// it will attempt to connect to MPC Web Interface every 15 seconds.
mediaEmitter.on('discordConnected', () => {
	clearInterval(discordRPCLoop);
	log.info('INFO: Connected to Discord. Listening MPC on ' + uri);
	checkMPCEndpoint();
	mpcServerLoop = setInterval(checkMPCEndpoint, 15000);
});

// If RPC gets disconnected from Discord Client,
// it will stop checking MPC playback data.
mediaEmitter.on('discordDisconnected', () => {
	clearInterval(mpcServerLoop);
	clearInterval(snapshotLoop);
	active = false;
});

// Tries to connect to MPC Web Interface and,
// if connected, fetches its data.
function checkMPCEndpoint() {
	axios
		.get(uri)
		.then(res => {
			mediaEmitter.emit('CONNECTED', res);
		})
		.catch(err => {
			mediaEmitter.emit('CONN_ERROR', err);
		});
}


async function uploadSnapshot() {
	log.info(`INFO: Uploading snapshot`);
	try {
		const { data: image } = await axios.get(`http://127.0.0.1:${config.port}/snapshot.jpg`, {
			validateStatus: status => status === 200,
			responseType: 'arraybuffer',
		});

		const thumbnail = await sharp(image).resize({ width: 512, height: 512, fit: 'cover', withoutEnlargement: true }).jpeg().toBuffer();
		log.info(`Thumbnail size ${Buffer.byteLength(thumbnail) / 1024} kB`);

		const form = new FormData();
		form.append('source', thumbnail, 'snapshot.jpg');

		const { data: response } = await axios.post('https://imgcdn.dev/api/1/upload/', form, {
			validateStatus: status => status === 200,
			params: {
				key: '5386e05a3562c7a8f984e73401540836',
			},
			data: form,
			headers: {
				...form.getHeaders(),
			},
		});

		snapshot = response.image.url;
		log.info(`INFO: Uploaded snapshot successfully ${snapshot}`);
	} catch (err) {
		log.error('ERROR: Error on transferring snapshot', err.message);
	}
}

// Initiates a new RPC connection to Discord client.
function initRPC(clientId) {
	try {
		rpc = new Client({ clientId, transport: { type: 'ipc' } });
		rpc.on('ready', () => {
			clearInterval(discordRPCLoop);
			mediaEmitter.emit('discordConnected');
			rpc.transport.on('error', err => log.error('RPC error', err));
			rpc.transport.once('close', async () => {
				await destroyRPC();
				log.error('ERROR: Connection to Discord client was closed. Trying again in 10 seconds...');
				mediaEmitter.emit('discordDisconnected');
				discordRPCLoop = setInterval(initRPC, 10000, clientId);
			});
		});

		// Log in to the RPC server on Discord client, and check whether or not it errors.
		rpc.login({ clientId }).catch(async err => {
			log.error('Error on RPC login', err);
			log.warn('WARN: Connection to Discord has failed. Trying again in 10 seconds...');
		});
	} catch (err) {
		log.error('Error on initRPC', err);
		log.warn('WARN: Connection to Discord has failed. Trying again in 10 seconds...');
	}
}

// Destroys any active RPC connection.
async function destroyRPC() {
	if (!rpc) return;
	await rpc.destroy();
	rpc = null;
}

// Boots the whole script, attempting to connect
// to Discord client every 10 seconds.
initRPC(clientId);
discordRPCLoop = setInterval(initRPC, 10000, clientId);

async function shutdown() {
	log.info('Shutting down...');
	try {
		await destroyRPC();
	} catch (err) {
		log.error('Error on shutdown', err);
	} finally {
		process.exit();
	}
}
