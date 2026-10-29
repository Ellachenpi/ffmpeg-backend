const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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
        cb(null, `${file.fieldname}_${Date.now()}_${Math.round(Math.random() * 1E9)}${ext}`); } });  const upload = multer({ storage: storage });  const queue = []; let isProcessing = false; let activeCommand = null; let currentProcessingJobId = null;  function processQueue() { if (isProcessing \vert{}\vert{} queue.length === 0) return; isProcessing = true; const task = queue.shift();  const jobs = getJobs(); if (jobs[task.jobId] && jobs[task.jobId].status === 'cancelled') { isProcessing = false; return processQueue(); }  runAudioCoreJob(task, () => { isProcessing = false; activeCommand = null; currentProcessingJobId = null; processQueue(); }); }  app.get('/auth/url', (req, res) => { const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI); const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] }); res.json({ url: authUrl }); });  app.post('/convert', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 10 }]), (req, res) => { try { if (!req.files \vert{}\vert{} !req.files['image']) return res.status(400).send('缺少靜態圖片檔案');  const accessToken = req.body.accessToken; if (!accessToken) return res.status(400).send('未提供有效的 YouTube 授權 Token');  const imageFile = req.files['image'][0]; const sourceType = req.body.sourceType \vert{}\vert{} 'file'; const ytTitle = req.body.title \vert{}\vert{} 'My Audio Track'; const ytDescription = req.body.description \vert{}\vert{} 'Uploaded with Web App'; const ytPrivacy = req.body.privacy \vert{}\vert{} 'private';  const createdJobIds = [];  if (sourceType === 'youtube') { let ytUrl = req.body.ytUrl; const startTime = req.body.startTime \vert{}\vert{} '00:00:00'; const endTime = req.body.endTime \vert{}\vert{} '00:05:00';  if (!ytUrl) return res.status(400).send('缺少 YouTube 影片網址');  let videoId = ''; if (ytUrl.includes('/live/')) { videoId = ytUrl.split('/live/')[1].split('?')[0]; } else if (ytUrl.includes('v=')) { videoId = ytUrl.split('v=')[1].split('&')[0]; } else if (ytUrl.includes('youtu.be/')) { videoId = ytUrl.split('youtu.be/')[1].split('?')[0]; }  if (!videoId) return res.status(400).send('無法解析有效的 Video ID');  const jobId = `job_${Date.now()}_yt`;
            updateJob(jobId, { status: 'queued', progress: '排隊中...', fileName: `YouTube 音訊區間 (${startTime} ~${endTime})`, videoUrl: null, error: null });
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
                const titleWithIndex = audioFiles.length > 1 ? `${ytTitle} (${index + 1}/${audioFiles.length})` : ytTitle;  updateJob(jobId, { status: 'queued', progress: '排隊中...', fileName: audioFile.originalname, videoUrl: null, error: null }); createdJobIds.push(jobId);  queue.push({ jobId, imageFile, sourceType: 'file', audioFile, accessToken, ytTitle: titleWithIndex, ytDescription, ytPrivacy }); }); }  res.json({ success: true, jobIds: createdJobIds }); processQueue();  } catch (err) { console.error('[伺服器例外錯誤]:', err); if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message); } });  app.post('/cancel/:jobId', (req, res) => { const jobId = req.params.jobId; updateJob(jobId, { status: 'cancelled', progress: '任務已被取消' });  const queueIndex = queue.findIndex(t => t.jobId === jobId); if (queueIndex !== -1) queue.splice(queueIndex, 1);  if (currentProcessingJobId === jobId && activeCommand) { try { activeCommand.kill('SIGKILL'); } catch (e) { console.error('Kill error:', e); } }  res.json({ success: true, message: `任務 ${jobId} 已取消` });
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

    const tempMp4Path = path.join(uploadDir, `upload_${jobId}.mp4`);  if (sourceType === 'youtube') { try { // 透過官方 API 通道發起帶 Authentication Header 的影音串流請求 const streamUrl = `https://www.youtube.com/watch?v=${videoId}`;
            let command = ffmpeg();
            activeCommand = command;

            command
                .input(imageFile.path)
                .inputOptions(['-loop 1'])
                .input(streamUrl)
                .inputOptions([
                    `-ss ${startTime}`, `-to ${endTime}`,
                    `-headers`, `Authorization: Bearer ${accessToken}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.
