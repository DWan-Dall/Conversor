# Conversor de vídeo

App web para converter vídeos grandes (700 MiB e além) para outros formatos. O upload vai direto para o disco (não fica na memória) e a conversão roda no servidor com FFmpeg, então o navegador não trava com arquivos grandes.

## Pré-requisitos

1. **Node.js** 18 ou superior.
2. **FFmpeg** instalado no sistema onde o servidor vai rodar (o pacote npm só chama o binário do sistema):
   - Ubuntu/Debian: `sudo apt install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Windows: baixe em https://ffmpeg.org/download.html e adicione ao PATH

## Instalação

```bash
cd Converter
npm install
```

## Rodar

```bash
npm start
```

Acesse `http://localhost:3000`.

## Como funciona

- **Upload**: arraste ou selecione o vídeo. O progresso de envio aparece em tempo real (barra "enviando").
- **Formato**: escolha o formato de saída (MP4, WEBM, MOV, AVI, MKV, GIF ou MP3 para extrair só o áudio).
- **Tamanho máximo (opcional)**: informe um valor em MB (ex. 200) e o servidor calcula o bitrate necessário para o vídeo caber nesse tamanho, com uma margem de segurança de ~4% (prefere ficar um pouco abaixo do pedido a estourar). Para formatos de vídeo isso usa encoding de duas passadas (mais lento, mas muito mais preciso que uma passada só). Não funciona com GIF — nesse formato o tamanho sai do jeito que o FFmpeg gerar.
- **Conversão**: ao clicar em "Converter", o servidor processa o arquivo com FFmpeg e o progresso da conversão aparece na barra "convertendo" (via Server-Sent Events). Ao terminar, o tamanho final real do arquivo é mostrado.
- **Download**: quando terminar, o botão de download aparece.

O arquivo original enviado é apagado do servidor assim que a conversão termina (com sucesso ou erro), para não acumular espaço em disco.

## Ajustes importantes

- **Limite de tamanho do upload**: por padrão é 3 GiB. Para mudar, defina a variável de ambiente `MAX_UPLOAD_MIB` (em MiB) antes de iniciar:
  ```bash
  MAX_UPLOAD_MIB=5120 npm start   # 5 GiB
  ```
- **Formatos permitidos**: a lista fica em `ALLOWED_FORMATS` no `server.js`. É uma whitelist proposital — evita passar valores arbitrários pro FFmpeg.
- **Codecs usados quando há tamanho alvo**: MP4/MOV/MKV → H.264 (ou o melhor disponível) + AAC; WEBM → VP9 + Opus; AVI → Xvid + MP3. Se o tamanho pedido for muito pequeno para a duração do vídeo, o app ainda tenta, mas avisa na tela que a qualidade vai cair bastante.
- **Rede de segurança de tamanho**: depois de converter, o app confere o tamanho real do arquivo. Se passou do pedido, reconverte automaticamente com bitrate mais baixo (até 3 vezes). Se mesmo assim não conseguir encaixar, avisa na tela qual foi o tamanho final — isso pode acontecer com AVI/Xvid em vídeos de conteúdo muito complexo (codec antigo, menos eficiente); para tamanho alvo, prefira MP4, WEBM ou MKV.
- **Onde ficam os arquivos**: `uploads/` (temporário, enviado pelo usuário) e `outputs/` (resultado da conversão, apagado manualmente ou pela sua própria rotina de limpeza — o app não apaga os outputs sozinho).

## Se for colocar em produção

- Coloque atrás de um proxy reverso (nginx, Caddy) e aumente o limite de body lá também (ex.: `client_max_body_size 3072m;` no nginx), senão o proxy corta o upload antes de chegar no Node.
- Rode com um gerenciador de processo (`pm2`, `systemd`) para reiniciar sozinho se cair.
- Adicione autenticação se o app ficar exposto publicamente — do jeito que está, qualquer pessoa com acesso à URL pode fazer upload e converter.
- Para várias conversões simultâneas por muitos usuários ao mesmo tempo, considere limitar a fila (ex.: uma conversão FFmpeg por vez) para não sobrecarregar a CPU do servidor.

## Estrutura

```
video-converter/
├── server.js          # backend Express + FFmpeg
├── package.json
├── public/
│   └── index.html      # interface
├── uploads/            # arquivos enviados (temporário)
└── outputs/            # arquivos convertidos
```
