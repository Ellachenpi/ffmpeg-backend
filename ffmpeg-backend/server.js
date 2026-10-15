const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// 設定檔案暫存區
const upload = multer({ dest: 'uploads/' });

app.post('/convert', upload.fields([{ name: 'image' }, { name: 'audio' }]), (req, res) => {
    try {
        const imageFile = req.files['image'][0];
        const audioFile = req.files['audio'][0];
        const enhanceType = req.body.enhance || 'none';

        const outputPath = path.join(__dirname, 'uploads', `output_${Date.now()}.mp4`);

        let command = ffmpeg()
            .input(imageFile.path)
            .loop()
            .input(audioFile.path)
            .videoCodec('libx264')
            .preset('ultrafast')
            .tune('stillimage')
            .size('1280x720')
            .fps(25)
            .audioCodec('aac')
            .audioBitrate('192k')
            .outputOptions([
                '-pix_fmt yuv420p',
                '-shortest',
                '-movflags +faststart'
            ]);

        // 聲音強化選項
        if (enhanceType === 'boost') {
            command.audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80');
        } else if (enhanceType === 'denoise') {
            command.audioFilters('highpass=f=120,volume=1.3');
        }

        command
            .on('end', () => {
                // 轉碼成功，回傳影片並刪除暫存檔
                res.download(outputPath, 'output.mp4', () => {
                    fs.unlinkSync(imageFile.path);
                    fs.unlinkSync(audioFile.path);
                    fs.unlinkSync(outputPath);
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg Error:', err);
                res.status(500).send('轉碼失敗：' + err.message);
                if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
            })
            .save(outputPath);

    } catch (err) {
        res.status(500).send('伺服器錯誤：' + err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));