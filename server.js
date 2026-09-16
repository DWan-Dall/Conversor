const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;

// Tamanho máximo de upload em bytes (padrão: 3 GiB). Ajuste via variável de ambiente se precisar.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MIB || 3072) * 1024 * 1024;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Formatos de saída permitidos (whitelist evita passar valores arbitrários para o ffmpeg)
const ALLOWED_FORMATS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'gif', 'mp3']);

// Candidatos de codec por formato, em ordem de preferência — o primeiro que existir
// no FFmpeg instalado é usado. Isso evita quebrar em builds sem libx264 (comum em
// distros como Fedora/Debian, que removem codecs sob patente).
const VIDEO_CODEC_CANDIDATES = {
  mp4: ['libx264', 'libopenh264', 'mpeg4'],
  mov: ['libx264', 'libopenh264', 'mpeg4'],
  mkv: ['libx264', 'libopenh264', 'mpeg4'],
  avi: ['libxvid', 'mpeg4', 'libx264'],
  webm: ['libvpx-vp9', 'libvpx']
};
const AUDIO_CODEC_CANDIDATES = {
  mp4: ['aac', 'libfdk_aac'],
  mov: ['aac', 'libfdk_aac'],
  mkv: ['aac', 'libfdk_aac'],
  avi: ['libmp3lame', 'mp3'],
  webm: ['libopus', 'libvorbis'],
  mp3: ['libmp3lame']
};

// Nome do muxer do ffmpeg para cada formato — nem sempre é igual à extensão do
// arquivo (o Matroska/.mkv é o caso clássico: o muxer se chama "matroska", não "mkv")
const CONTAINER_FORMAT = { mp4: 'mp4', mov: 'mov', mkv: 'matroska', avi: 'avi', webm: 'webm', gif: 'gif', mp3: 'mp3' };

let encodersCache = null;
function getAvailableEncoders() {
  if (encodersCache) return Promise.resolve(encodersCache);
  return new Promise((resolve, reject) => {
    ffmpeg.getAvailableEncoders((err, encoders) => {
      if (err) return reject(err);
      encodersCache = encoders;
      resolve(encoders);
    });
  });
}

function pickEncoder(candidates, encoders, kind) {
  const found = candidates.find((c) => encoders[c]);
  if (!found) {
    throw new Error(
      `Nenhum encoder de ${kind} disponível neste FFmpeg entre: ${candidates.join(', ')}. Rode "ffmpeg -encoders" no terminal para ver o que está instalado.`
    );
  }
  return found;
}

// Resolve os codecs a usar para um formato, checando o que está de fato disponível
async function resolveCodecs(format) {
  if (format === 'gif') return { vcodec: null, acodec: null };
  const encoders = await getAvailableEncoders();
  if (format === 'mp3') {
    return { vcodec: null, acodec: pickEncoder(AUDIO_CODEC_CANDIDATES.mp3, encoders, 'áudio') };
  }
  return {
    vcodec: pickEncoder(VIDEO_CODEC_CANDIDATES[format], encoders, 'vídeo'),
    acodec: pickEncoder(AUDIO_CODEC_CANDIDATES[format], encoders, 'áudio')
  };
}

// Estado dos jobs em memória: jobId -> { status, progress, inputPath, outputPath, originalName, error, warning, outputSizeBytes }
const jobs = new Map();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const jobId = crypto.randomUUID();
    req.jobId = jobId;
    const ext = path.extname(file.originalname) || '';
    cb(null, `${jobId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Upload -------------------------------------------------------------
app.post('/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Arquivo excede o limite de ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB` });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const jobId = req.jobId;
    jobs.set(jobId, {
      status: 'uploaded',
      progress: 0,
      inputPath: req.file.path,
      originalName: req.file.originalname,
      outputPath: null,
      outputSizeBytes: null,
      error: null,
      warning: null
    });
    res.json({ jobId, originalName: req.file.originalname });
  });
});

// --- Helpers de conversão -------------------------------------------------

function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(new Error('Não foi possível ler o vídeo de entrada (arquivo corrompido ou formato não suportado)'));
      const duration = Number(data && data.format && data.format.duration);
      if (!duration || Number.isNaN(duration) || duration <= 0) {
        return reject(new Error('Não foi possível determinar a duração do vídeo'));
      }
      resolve(duration);
    });
  });
}

// Calcula o bitrate de vídeo/áudio necessário para caber no tamanho alvo
function computeBitrates(targetSizeMB, durationSec, format) {
  const targetBytes = targetSizeMB * 1024 * 1024 * 0.9; // 10% de margem — passada única é menos precisa que duas passadas
  const targetTotalKbps = (targetBytes * 8) / durationSec / 1000;

  if (format === 'mp3') {
    const audioKbps = Math.max(32, Math.min(320, Math.round(targetTotalKbps)));
    return { audioKbps, videoKbps: null, warning: null };
  }

  let audioKbps = targetTotalKbps < 160 ? 64 : 128;
  let videoKbps = Math.round(targetTotalKbps - audioKbps);
  let warning = null;

  if (videoKbps < 150) {
    videoKbps = Math.max(80, videoKbps);
    warning = 'O tamanho pedido é bem apertado para a duração do vídeo — a qualidade vai cair bastante.';
  }

  return { audioKbps, videoKbps, warning };
}

// Conversão simples, sem controle de tamanho (comportamento anterior)
function plainConvert({ inputPath, outputPath, format, vcodec, acodec, job }) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath).outputOptions(['-threads', '0']);
    if (format === 'mp3') {
      command.noVideo();
      if (acodec) command.audioCodec(acodec);
    } else {
      if (vcodec) command.videoCodec(vcodec);
      if (acodec) command.audioCodec(acodec);
    }
    command
      .toFormat(CONTAINER_FORMAT[format] || format)
      .on('progress', (p) => {
        if (typeof p.percent === 'number' && !Number.isNaN(p.percent)) {
          job.progress = Math.max(0, Math.min(99, Math.round(p.percent)));
        }
      })
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// MP3 com bitrate calculado para bater o tamanho alvo (passada única já é precisa o bastante para áudio)
function singlePassAudio({ inputPath, outputPath, audioKbps, acodec, job }) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec(acodec)
      .audioBitrate(audioKbps)
      .outputOptions(['-threads', '0'])
      .toFormat('mp3')
      .on('progress', (p) => {
        if (typeof p.percent === 'number' && !Number.isNaN(p.percent)) {
          job.progress = Math.max(0, Math.min(99, Math.round(p.percent)));
        }
      })
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// Vídeo com bitrate calculado, em passada única com maxrate/bufsize (VBV) para conter o tamanho.
// É bem mais rápido que duas passadas (não precisa reler o arquivo inteiro duas vezes) — a troca é
// uma precisão um pouco menor, compensada pela margem de segurança maior em computeBitrates().
function singlePassVideo({ inputPath, outputPath, format, videoKbps, audioKbps, vcodec, acodec, job }) {
  return new Promise((resolve, reject) => {
    const maxrate = Math.round(videoKbps * 1.45);
    const bufsize = Math.round(videoKbps * 2);

    ffmpeg(inputPath)
      .videoCodec(vcodec)
      .videoBitrate(videoKbps)
      .audioCodec(acodec)
      .audioBitrate(audioKbps)
      .outputOptions(['-maxrate', `${maxrate}k`, '-bufsize', `${bufsize}k`, '-threads', '0'])
      .toFormat(CONTAINER_FORMAT[format] || format)
      .on('progress', (p) => {
        if (typeof p.percent === 'number' && !Number.isNaN(p.percent)) {
          job.progress = Math.max(0, Math.min(99, Math.round(p.percent)));
        }
      })
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// Roda a conversão com tamanho alvo e, se o resultado passar do tamanho pedido
// (alguns codecs/conteúdos não respeitam o -maxrate/-bufsize com precisão — foi
// o caso do encoder mpeg4 nativo em vídeo de alto movimento), reconverte com um
// bitrate mais baixo, proporcional ao quanto passou. Até 2 tentativas extras.
async function encodeToTargetSize({ inputPath, outputPath, format, targetSizeMB, vcodec, acodec, job }) {
  const duration = await probeDuration(inputPath);
  let { videoKbps, audioKbps, warning } = computeBitrates(targetSizeMB, duration, format);
  job.warning = warning;

  const targetBytes = targetSizeMB * 1024 * 1024;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    job.progress = 0;
    if (format === 'mp3') {
      await singlePassAudio({ inputPath, outputPath, audioKbps, acodec, job });
    } else {
      await singlePassVideo({ inputPath, outputPath, format, videoKbps, audioKbps, vcodec, acodec, job });
    }

    const size = fs.statSync(outputPath).size;
    if (size <= targetBytes || attempt === maxAttempts) {
      if (size > targetBytes) {
        const extra = `Não foi possível encaixar exatamente no tamanho pedido — o arquivo final ficou em ${(size / (1024 * 1024)).toFixed(1)} MB.`;
        job.warning = job.warning ? `${job.warning} ${extra}` : extra;
      }
      return;
    }

    // Recalcula o bitrate proporcionalmente ao quanto passou do alvo, com uma margem extra
    const ratio = (targetBytes / size) * 0.8;
    if (format === 'mp3') {
      audioKbps = Math.max(32, Math.round(audioKbps * ratio));
    } else {
      videoKbps = Math.max(60, Math.round(videoKbps * ratio));
    }
  }
}

// --- Iniciar conversão ---------------------------------------------------
app.post('/convert/:jobId', (req, res) => {
  const { jobId } = req.params;
  const format = String(req.body.format || '').toLowerCase();
  const targetSizeMB = req.body.targetSizeMB ? Number(req.body.targetSizeMB) : null;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  if (!ALLOWED_FORMATS.has(format)) {
    return res.status(400).json({ error: `Formato inválido. Use um de: ${[...ALLOWED_FORMATS].join(', ')}` });
  }
  if (job.status === 'converting') {
    return res.status(409).json({ error: 'Conversão já em andamento' });
  }
  if (targetSizeMB !== null && (Number.isNaN(targetSizeMB) || targetSizeMB <= 0)) {
    return res.status(400).json({ error: 'Tamanho alvo inválido' });
  }
  if (targetSizeMB !== null && format === 'gif') {
    return res.status(400).json({ error: 'Tamanho alvo não é suportado para GIF' });
  }

  const outputFileName = `${jobId}.${format}`;
  const outputPath = path.join(OUTPUT_DIR, outputFileName);
  job.status = 'converting';
  job.progress = 0;
  job.error = null;
  job.warning = null;

  res.json({ started: true });

  (async () => {
    try {
      const { vcodec, acodec } = await resolveCodecs(format);

      if (targetSizeMB) {
        await encodeToTargetSize({ inputPath: job.inputPath, outputPath, format, targetSizeMB, vcodec, acodec, job });
      } else {
        await plainConvert({ inputPath: job.inputPath, outputPath, format, vcodec, acodec, job });
      }

      const stats = fs.statSync(outputPath);
      job.status = 'done';
      job.progress = 100;
      job.outputPath = outputPath;
      job.outputSizeBytes = stats.size;
      fs.unlink(job.inputPath, () => {});
    } catch (err) {
      job.status = 'error';
      job.error = err.message || 'Falha na conversão';
      fs.unlink(job.inputPath, () => {});
    }
  })();
});

// --- Progresso via Server-Sent Events ------------------------------------
app.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    const job = jobs.get(jobId);
    if (!job) {
      send({ status: 'error', error: 'Job não encontrado' });
      clearInterval(interval);
      return res.end();
    }
    send({
      status: job.status,
      progress: job.progress,
      error: job.error,
      warning: job.warning,
      sizeBytes: job.outputSizeBytes
    });
    if (job.status === 'done' || job.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 700);

  req.on('close', () => clearInterval(interval));
});

// --- Download --------------------------------------------------------------
app.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.outputPath) {
    return res.status(404).send('Arquivo não disponível');
  }
  const base = path.parse(job.originalName || 'video').name;
  const ext = path.extname(job.outputPath);
  res.download(job.outputPath, `${base}${ext}`);
});

const server = app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

// Uploads grandes podem demorar; evita que o servidor derrube a conexão cedo demais
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 30 * 60 * 1000; // 30 minutos
