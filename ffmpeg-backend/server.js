const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = '124484081362-42ffam7ts867htags708jsb4rg88vl4e.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'https://ffmpeg-backend-72s6.onrender.com/auth/callback';

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const jobsFilePath = path.join(__dirname, 'jobs.json');

function getJobs() {
    if (!fs.existsSync(jobsFilePath)) return {};
    try { return JSON.parse(fs.readFileSync(jobsFilePath, 'utf8')); } catch (e) { return {}; }
}

function updateJob(jobId, data) {
    const jobs = getJobs();
    jobs[jobId] = { ...(jobs[jobId] || {}), ...data, updatedAt: new Date() };
    fs.writeFileSync(jobsFilePath, JSON.stringify(jobs, null, 2));
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || (file.fieldname === 'image' ? '.jpg' : '.mp3');
        cb(null, `${file.fieldname}_${Date.now()}_${Math.round(Math.random() * 1E9)}${ext}`);
    }
});

const upload = multer({ storage: storage });

const queue = [];
let isProcessing = false;
let activeCommand = null;
let currentProcessingJobId = null;

function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const task = queue.shift();

    const jobs = getJobs();
    if (jobs[task.jobId] && jobs[task.jobId].status === 'cancelled') {
        isProcessing = false;
        return processQueue();
    }

    runAudioCoreJob(task, () => {
        isProcessing = false;
        activeCommand = null;
        currentProcessingJobId = null;
        processQueue();
    });
}

// 可靠的多備用節點第三方 API 解析
async function getAudioUrlFromThirdParty(videoId) {
    const endpoints = [
        { host: 'api.cobalt.tools', path: '/' },
        { host: 'cobalt.copy.live', path: '/' }
    ];

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

    for (const ep of endpoints) {
        try {
            const streamUrl = await fetchCobaltAudio(ep.host, ep.path, targetUrl);
            if (streamUrl) return streamUrl;
        } catch (err) {
            console.warn(`[API 節點 ${ep.host} 失敗，嘗試下一個]:`, err.message);
        }
    }
    throw new Error('所有備用音訊解析 API 均無法回應');
}

function fetchCobaltAudio(hostname, apiPath, targetUrl) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            url: targetUrl,
            downloadMode: 'audio',
            audioFormat: 'mp3',
            isAudioOnly: true
        });

        const options = {
            hostname: hostname,
            path: apiPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.url) {
                        resolve(parsed.url);
                    } else if (parsed.picker && parsed.picker.length > 0) {
                        resolve(parsed.picker[0].url);
                    } else {
                        reject(new Error(parsed.text || '解析結果無有效網址'));
                    }
                } catch (e) {
                    reject(new Error('JSON 回應解析錯誤'));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('連線逾時')); });
        req.write(postData);
        req.end();
    });
}

app.post('/convert', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 10 }]), (req, res) => {
    try {
        if (!req.files || !req.files['image']) return res.status(400).send('缺少靜態圖片檔案');

        const accessToken = req.body.accessToken;
        if (!accessToken) return res.status(400).send('未提供有效的 YouTube 授權 Token');

        const imageFile = req.files['image'][0];
        const sourceType = req.body.sourceType || 'file';
        const ytTitle = req.body.title || 'My Audio Track';
        const ytDescription = req.body.description || 'Uploaded with Web App';
        const ytPrivacy = req.body.privacy || 'private';

        const createdJobIds = [];

        if (sourceType === 'youtube') {
            let ytUrl = req.body.ytUrl;
            const startTime = req.body.startTime || '00:00:00';
            const endTime = req.body.endTime || '00:05:00';

            if (!ytUrl) return res.status(400).send('缺少 YouTube 影片網址');

            let videoId = '';
            if (ytUrl.includes('/live/')) {
                videoId = ytUrl.split('/live/')[1].split('?')[0];
            } else if (ytUrl.includes('v=')) {
                videoId = ytUrl.split('v=')[1].split('&')[0];
            } else if (ytUrl.includes('youtu.be/')) {
                videoId = ytUrl.split('youtu.be/')[1].split('?')[0];
            }

            if (!videoId) return res.status(400).send('無法解析有效的 Video ID');

            const jobId = `job_${Date.now()}_yt`;
            updateJob(jobId, { status: 'queued', progress: '排隊中...', fileName: `YouTube 音訊區間 (${startTime} ~ ${endTime})`, videoUrl: null, error: null });
            createdJobIds.push(jobId);

            queue.push({
                jobId, imageFile, sourceType: 'youtube', videoId, startTime, endTime,
                accessToken, ytTitle, ytDescription, ytPrivacy
            });

        } else {
            const audioFiles = req.files['audio'];
            if (!audioFiles || audioFiles.length === 0) return res.status(400).send('缺少音訊檔案');

            audioFiles.forEach((audioFile, index) => {
                const jobId = `job_${Date.now()}_${index + 1}`;
                const titleWithIndex = audioFiles.length > 1 ? `${ytTitle} (${index + 1}/${audioFiles.length})` : ytTitle;

                updateJob(jobId, { status: 'queued', progress: '排隊中...', fileName: audioFile.originalname, videoUrl: null, error: null });
                createdJobIds.push(jobId);

                queue.push({
                    jobId, imageFile, sourceType: 'file', audioFile,
                    accessToken, ytTitle: titleWithIndex, ytDescription, ytPrivacy
                });
            });
        }

        res.json({ success: true, jobIds: createdJobIds });
        processQueue();

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message);
    }
});

app.post('/cancel/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    updateJob(jobId, { status: 'cancelled', progress: '任務已被取消' });

    const queueIndex = queue.findIndex(t => t.jobId === jobId);
    if (queueIndex !== -1) queue.splice(queueIndex, 1);

    if (currentProcessingJobId === jobId && activeCommand) {
        try { activeCommand.kill('SIGKILL'); } catch (e) { console.error('Kill error:', e); }
    }

    res.json({ success: true, message: `任務 ${jobId} 已取消` });
});

app.get('/status/batch', (req, res) => {
    const idsParam = req.query.ids;
    if (!idsParam) return res.status(400).json({ error: '缺少 ids 參數' });
    const jobIds = idsParam.split(',');
    const jobs = getJobs();
    const result = {};
    jobIds.forEach(id => { if (jobs[id]) result[id] = jobs[id]; });
    res.json(result);
});

async function runAudioCoreJob(task, next) {
    const { jobId, imageFile, sourceType, audioFile, videoId, startTime, endTime, accessToken, ytTitle, ytDescription, ytPrivacy } = task;

    currentProcessingJobId = jobId;
    console.log(`[任務開始] JobID: ${jobId}, 模式: ${sourceType}`);
    updateJob(jobId, { status: 'processing', progress: '00:00:00 (音訊處理中)' });

    const tempMp4Path = path.join(uploadDir, `upload_${jobId}.mp4`);

    if (sourceType === 'youtube') {
        try {
            console.log(`[${jobId}] 正在透過第三方 API 繞過機房 IP 解析音訊...`);
            const directAudioUrl = await getAudioUrlFromThirdParty(videoId);

            let command = ffmpeg();
            activeCommand = command;

            command
                .input(imageFile.path)
                .inputOptions(['-loop 1'])
                .input(directAudioUrl)
                .inputOptions([`-ss ${startTime}`, `-to ${endTime}`])
                .videoCodec('libx264')
                .size('480x270')
                .fps(1)
                .outputOptions(['-preset ultrafast', '-tune stillimage', '-pix_fmt yuv420p', '-threads 1'])
                .audioCodec('aac')
                .audioBitrate('128k')
                .output(tempMp4Path)
                .on('progress', (p) => {
                    if (p.timemark) updateJob(jobId, { progress: `${p.timemark} (壓碼中)` });
                })
                .on('end', () => startYoutubeUpload(jobId, accessToken, tempMp4Path, ytTitle, ytDescription, ytPrivacy, audioFile, next))
                .on('error', (err) => handleFfmpegError(err, jobId, audioFile, tempMp4Path, next))
                .run();

        } catch (err) {
            console.error('第三方音訊解析失敗:', err);
            updateJob(jobId, { status: 'error', error: 'YouTube 音訊擷取失敗：' + err.message });
            if (audioFile) cleanupFiles(audioFile.path, tempMp4Path);
            return next();
        }
    } else {
        let command = ffmpeg();
        activeCommand = command;

        command
            .input(imageFile.path)
            .inputOptions(['-loop 1'])
            .input(audioFile.path)
            .videoCodec('libx264')
            .size('480x270')
            .fps(1)
            .outputOptions(['-preset ultrafast', '-tune stillimage', '-pix_fmt yuv420p', '-shortest', '-threads 1'])
            .audioCodec('aac')
            .audioBitrate('128k')
            .output(tempMp4Path)
            .on('progress', (p) => {
                if (p.timemark) updateJob(jobId, { progress: `${p.timemark} (壓碼中)` });
            })
            .on('end', () => startYoutubeUpload(jobId, accessToken, tempMp4Path, ytTitle, ytDescription, ytPrivacy, audioFile, next))
            .on('error', (err) => handleFfmpegError(err, jobId, audioFile, tempMp4Path, next))
            .run();
    }
}

async function startYoutubeUpload(jobId, accessToken, tempMp4Path, ytTitle, ytDescription, ytPrivacy, audioFile, next) {
    const jobs = getJobs();
    if (jobs[jobId] && jobs[jobId].status === 'cancelled') {
        cleanupFiles(audioFile ? audioFile.path : null, tempMp4Path);
        return next();
    }

    console.log(`[${jobId}] 壓碼完成！開始發布至 YouTube...`);
    updateJob(jobId, { progress: '壓碼完成，正在發布至 YouTube...' });

    try {
        const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
        auth.setCredentials({ access_token: accessToken });
        const youtube = google.youtube({ version: 'v3', auth: auth });

        const res = await youtube.videos.insert({
            part: ['snippet', 'status'],
            requestBody: {
                snippet: { title: ytTitle, description: ytDescription, categoryId: '10' },
                status: { privacyStatus: ytPrivacy }
            },
            media: {
                body: fs.createReadStream(tempMp4Path)
            }
        });

        console.log(`[${jobId} 上傳成功] Video ID: ${res.data.id}`);
        updateJob(jobId, { status: 'completed', videoUrl: `https://youtu.be/${res.data.id}` });

    } catch (ytErr) {
        console.error(`[${jobId} 上傳失敗]:`, ytErr);
        updateJob(jobId, { status: 'error', error: 'YouTube 上傳失敗：' + (ytErr.message || '授權失效') });
    } finally {
        cleanupFiles(audioFile ? audioFile.path : null, tempMp4Path);
        next();
    }
}

function handleFfmpegError(err, jobId, audioFile, tempMp4Path, next) {
    const jobs = getJobs();
    if (jobs[jobId] && jobs[jobId].status === 'cancelled') {
        console.log(`[${jobId}] 任務已手動中止`);
    } else {
        console.error(`[${jobId} FFmpeg 錯誤]:`, err);
        updateJob(jobId, { status: 'error', error: '音訊處理失敗：' + err.message });
    }
    cleanupFiles(audioFile ? audioFile.path : null, tempMp4Path);
    next();
}

function cleanupFiles(audioPath, mp4Path) {
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (mp4Path && fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
