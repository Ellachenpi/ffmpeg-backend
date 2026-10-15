const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || (file.fieldname === 'image' ? '.jpg' : '.mp3');
        cb(null, `${file.fieldname}_${Date.now()}${ext}`);
    }
});

const upload = multer({ storage: storage });

app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), (req, res) => {
    req.setTimeout(1800000); // 30 分鐘超時防護
    res.setTimeout(1800000);

    try {
        if (!req.files || !req.files['image'] || !req.files['audio']) {
            return res.status(400).send('缺少圖片或音訊檔案');
        }

        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const enhanceType = req.body.enhance || 'none';

        const outputPath = path.join(uploadDir, `output_${Date.now()}.mp4`);

        console.log(`[開始壓碼] 圖片: ${imageFile.path}, 音檔: ${audioFile.path}, 強化: ${enhanceType}`);

        let command = ffmpeg()
            .input(imageFile.path)
            .inputOptions(['-loop 1'])
            .input(audioFile.path)
            .videoCodec('libx264')
            .size('1280x720')
            .fps(1)
            .outputOptions([
                '-preset ultrafast',
                '-tune stillimage',
                '-pix_fmt yuv420p',
                '-shortest',
                '-threads 0',
                '-movflags +faststart'
            ]);

        if (enhanceType === 'none') {
            command.audioCodec('copy');
        } else if (enhanceType === 'boost') {
            command.audioCodec('aac').audioBitrate('128k').audioFilters('volume=1.4,highpass=f=80');
        } else if (enhanceType === 'denoise') {
            command.audioCodec('aac').audioBitrate('128k').audioFilters('highpass=f=120,volume=1.3');
        }

        command
            .on('progress', (progress) => {
                if (progress.timemark) {
                    console.log(`[壓碼進度] 已處理時間: ${progress.timemark}`);
                }
            })
            .on('end', () => {
                console.log('[壓碼成功] 開始以 Stream 串流傳送影片回前端...');
                
                const stat = fs.statSync(outputPath);
                res.writeHead(200, {
                    'Content-Type': 'video/mp4',
                    'Content-Length': stat.size,
                    'Content-Disposition': 'attachment; filename="output.mp4"'
                });

                const readStream = fs.createReadStream(outputPath);
                readStream.pipe(res);

                readStream.on('close', () => {
                    console.log('[傳輸完成] 清理暫存檔案...');
                    if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                    if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                });
            })
            .on('error', (err) => {
                console.error('[FFmpeg 錯誤]:', err);
                if (!res.headersSent) res.status(500).send('轉碼失敗：' + err.message);
                if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            })
            .save(outputPath);

    } catch (err) {
        console.error('[伺服器例外錯誤]:', err);
        if (!res.headersSent) res.status(500).send('伺服器錯誤：' + err.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
