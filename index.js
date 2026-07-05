const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

if (!global.WebSocket) {
  try { global.WebSocket = require('ws'); } catch (_) {}
}

// Auto-patch LibavDemuxer.js for Node v20 compatibility
const libavPath = path.join(__dirname, 'node_modules', '@dank074', 'discord-video-stream', 'dist', 'media', 'LibavDemuxer.js');
if (fs.existsSync(libavPath)) {
    let code = fs.readFileSync(libavPath, 'utf8');
    if (code.includes('const readFrame = pDebounce.promise') && !code.includes('let readFrame')) {
        code = code.replace(
            'async function demux(input, { format }) {',
            'async function demux(input, { format }) {\n    let readFrame;'
        );
        code = code.replace('const readFrame = pDebounce.promise', 'readFrame = pDebounce.promise');
        fs.writeFileSync(libavPath, code);
        console.log('Patched LibavDemuxer.js');
    }
}

const { Client } = require('discord.js-selfbot-v13');
const { Streamer, playStream } = require('@dank074/discord-video-stream');
const { spawn, execSync } = require('child_process');

const client = new Client({ intents: 33281 });
const streamer = new Streamer(client);

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1324034047613079574';
const VOICE_ID = '1523292663636295811';
const VOICE_TEXT_ID = '1523292663636295811';
const OWNER_IDS = ['820408813790167041', '1117202633510359070', '1154082560108920963', '1120172313401364572', '742858908774826045'];

const IPTV = {
    host: 'http://ugeen.live',
    ip: 'http://176.123.9.60',
    port: '8080',
    user: 'Ugeen_VIP1pjmEs',
    pass: 'v0CvBh',
};

const M3U_URL = `${IPTV.ip}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u_plus&output=ts`;

const QUALITY_PRESETS = {
    lowend: { width: 640, height: 360, fps: 20, bitrate: '500k', maxrate: '500k', bufsize: '1000k' },
    low: { width: 854, height: 480, fps: 24, bitrate: '800k', maxrate: '800k', bufsize: '1600k' },
    medium: { width: 960, height: 540, fps: 25, bitrate: '2000k', maxrate: '2000k', bufsize: '4000k' },
    high: { width: 1280, height: 720, fps: 30, bitrate: '2500k', maxrate: '2500k', bufsize: '5000k' },
};

let selectedQuality = QUALITY_PRESETS.medium;
let currentChannelName = null;
let channelsCache = null;
let isPlaying = false;
let ffmpegProcess = null;

function findFfmpeg() {
    const paths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
    for (const p of paths) { if (fs.existsSync(p)) return p; }
    try { const r = execSync('which ffmpeg', { encoding: 'utf8', timeout: 3000 }); if (r) return r.trim(); } catch (_) {}
    try { const r = execSync('where ffmpeg', { encoding: 'utf8', timeout: 3000 }); if (r) return r.trim().split('\n')[0]; } catch (_) {}
    try { return require('ffmpeg-static'); } catch (_) { return null; }
}
const ffmpegPath = findFfmpeg();

function parseM3U(m3uText) {
    const channels = {};
    const lines = m3uText.split('\n');
    let index = 1;
    let currentName = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF:')) {
            const nameMatch = trimmed.match(/tvg-name="([^"]*)"/) || trimmed.match(/,([^,]+)$/);
            if (nameMatch) { currentName = nameMatch[1].trim(); }
        } else if (trimmed.startsWith('http') && currentName) {
            const url = trimmed.replace('ugeen.live', '176.123.9.60');
            channels[String(index)] = { name: currentName, url };
            index++; currentName = null;
        }
    }
    return channels;
}

async function fetchChannels() {
    if (channelsCache) return channelsCache;
    const urls = [
        M3U_URL,
        M3U_URL.replace('&output=ts', ''),
        `${IPTV.host}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u`,
    ];
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (!text.startsWith('#EXTM3U')) throw new Error('Not M3U');
            channelsCache = parseM3U(text);
            console.log(`Fetched ${Object.keys(channelsCache).length} channels`);
            return channelsCache;
        } catch (e) {
            console.error(`Failed: ${url.slice(0, 60)}... ${e.message}`);
        }
    }
    if (channelsCache) return channelsCache;
    throw new Error('Failed to fetch channels');
}

client.on('ready', async () => {
    console.log(`Logged in as: ${client.user.tag}`);
    if (ffmpegPath) console.log(`FFmpeg: ${ffmpegPath}`);
    else console.log('FFmpeg NOT FOUND');
    try { await fetchChannels(); } catch (_) {}
    const keepVoice = async () => {
        try { await streamer.joinVoice(GUILD_ID, VOICE_ID).catch(() => {}); console.log('Voice OK'); } catch (_) {}
    };
    await keepVoice();
    setInterval(keepVoice, 300000);
});

async function runCommand(cmd, reply) {
    const trim = cmd.startsWith('!') ? cmd : '!' + cmd;
    try {
        if (trim === '!tv' || /^!tv \d+$/.test(trim)) {
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) return reply('No channels.');
            const page = trim === '!tv' ? 1 : parseInt(trim.split(' ')[1], 10);
            const entries = Object.entries(channels);
            const totalPages = Math.ceil(entries.length / 30);
            const p = Math.max(1, Math.min(page, totalPages));
            const start = (p - 1) * 30;
            const list = entries.slice(start, start + 30).map(([k, ch]) => `${k}. ${ch.name}`).join('\n');
            return reply(`Page ${p}/${totalPages} (${entries.length} channels)\n${list}`);
        }

        if (trim.startsWith('!quality ')) {
            const preset = trim.split(' ')[1];
            if (!QUALITY_PRESETS[preset]) return reply('Options: lowend, low, medium, high');
            selectedQuality = QUALITY_PRESETS[preset];
            return reply(`Quality: ${preset} (${selectedQuality.width}x${selectedQuality.height}, ${selectedQuality.fps}fps)`);
        }

        if (trim.startsWith('!play ')) {
            if (isPlaying) return reply('Already playing. Use !stop first.');
            const channelKey = trim.split(' ')[1];
            const channels = await fetchChannels();
            if (!channels) return reply('Failed to fetch channels.');
            const channel = channels[channelKey];
            if (!channel) return reply(`Channel ${channelKey} not found.`);

            currentChannelName = channel.name;
            isPlaying = true;
            reply(`Starting ${channel.name}...`);

            try { await streamer.joinVoice(GUILD_ID, VOICE_ID); } catch (_) {}
            console.log(`Playing: ${channel.name}`);

            if (ffmpegPath) {
                const { width, height, fps, bitrate, maxrate, bufsize } = selectedQuality;
                ffmpegProcess = spawn(ffmpegPath, [
                    '-headers', 'User-Agent: VLC/3.0.20 LibVLC/3.0.20\r\n',
                    '-timeout', '30000000',
                    '-re',
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '10',
                    '-analyzeduration', '2000000',
                    '-probesize', '2000000',
                    '-thread_queue_size', '512',
                    '-i', channel.url,
                    '-fflags', '+nobuffer+discardcorrupt',
                    '-flags', '+low_delay',
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-tune', 'zerolatency',
                    '-ar', '48000',
                    '-c:a', 'libopus',
                    '-b:a', '96k',
                    '-s', `${width}x${height}`,
                    '-r', String(fps),
                    '-maxrate', maxrate,
                    '-bufsize', bufsize,
                    '-pix_fmt', 'yuv420p',
                    '-f', 'mpegts',
                    'pipe:1',
                ], { stdio: ['pipe', 'pipe', 'pipe'] });

                let ffmpegStderr = '';
                ffmpegProcess.stderr.on('data', (chunk) => ffmpegStderr += chunk.toString());
                ffmpegProcess.stdout.on('error', () => {});
                ffmpegProcess.on('error', (err) => console.error('FFmpeg error:', err.message));
                ffmpegProcess.on('exit', (code, signal) => {
                    console.log(`FFmpeg exit (code=${code}, signal=${signal})`);
                    if (code !== 0 && code !== null) {
                        console.error(ffmpegStderr.split('\n').slice(-3).join('\n'));
                    }
                    ffmpegProcess = null;
                });

                const buf = new PassThrough({ highWaterMark: 1024 * 1024 * 16 });
                ffmpegProcess.stdout.pipe(buf);
                await playStream(buf, streamer, {
                    type: 'go-live', format: 'mpegts',
                    width: selectedQuality.width,
                    height: selectedQuality.height,
                    frameRate: selectedQuality.fps,
                });
            }

            isPlaying = false;
            return reply(`Finished ${channel.name}.`);
        }

        if (trim === '!stop') {
            const name = currentChannelName || '';
            if (ffmpegProcess) { try { ffmpegProcess.kill('SIGTERM'); } catch (_) {} ffmpegProcess = null; }
            streamer.stopStream();
            currentChannelName = null;
            isPlaying = false;
            return reply(`Stopped ${name}.`);
        }

        if (trim === '!txt') {
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) return;
            const lines = Object.entries(channels).map(([num, ch]) => `${num}. ${ch.name}`);
            const fp = path.join(__dirname, 'channels.txt');
            fs.writeFileSync(fp, lines.join('\n'), 'utf8');
            return reply(`Exported ${lines.length} channels.`);
        }

        if (trim === '!status') {
            return reply(
                (isPlaying ? `Playing: ${currentChannelName || '?'}` : 'Stopped') +
                `\n${selectedQuality.width}x${selectedQuality.height} @ ${selectedQuality.fps}fps`
            );
        }

        if (trim === '!help') {
            return reply([
                'Commands:', '',
                'play <num> - play channel',
                'stop - stop stream',
                'quality <lowend|low|medium|high>',
                'tv - list channels',
                'status - show status',
                'txt - export channels.txt',
                'help - this help',
            ].join('\n'));
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Error:', err.message);
            reply(`Error: ${err.message}`);
        }
        isPlaying = false;
        if (ffmpegProcess) { try { ffmpegProcess.kill('SIGTERM'); } catch (_) {} ffmpegProcess = null; }
        streamer.stopStream();
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== VOICE_TEXT_ID) return;
    if (!OWNER_IDS.includes(message.author.id)) return;
    let cmd = message.content;
    if (cmd.startsWith('p ')) cmd = '!' + cmd.slice(2);
    if (cmd.startsWith('p')) cmd = '!' + cmd.slice(1);
    await runCommand(cmd, async (t) => {
        try { await message.channel.send(t); } catch (e) { console.log('[send fail]', e.message); }
    });
});

const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.on('line', (line) => {
    const cmd = line.trim();
    if (cmd) runCommand(cmd, (t) => console.log(t));
    rl.prompt();
});
rl.prompt();

client.login(TOKEN);
