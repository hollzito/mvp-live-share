[README.md](https://github.com/user-attachments/files/31605373/README.md)
# MVP - Transmissão de tela com código + clipes

Quem transmite compartilha a tela e recebe um código de 4 letras. Quem assiste digita o código e o vídeo chega via WebRTC (baixa latência). Qualquer espectador pode clipar os últimos 30 ou 60 segundos, e o clipe fica salvo permanentemente, visível na galeria pra todo mundo.

## Configurar o Cloudinary (necessário para os clipes)

Os clipes são vídeos, e precisam ficar guardados em algum lugar permanente (o Render, onde o app roda, apaga arquivos locais quando reinicia). Por isso usamos o Cloudinary, que tem plano gratuito.

1. Crie uma conta grátis em [cloudinary.com](https://cloudinary.com).
2. No painel (Dashboard), copie três valores: **Cloud name**, **API Key** e **API Secret**.
3. Localmente: copie o arquivo `.env.example` para `.env` e preencha os três valores.
4. No Render: vá em Settings do seu serviço → **Environment** → adicione as três variáveis (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`) com os mesmos valores.

Sem essas variáveis configuradas, o app continua funcionando normalmente para transmitir/assistir — só os clipes ficam desativados (o botão retorna erro ao tentar salvar).

## Enviar clipes automaticamente pro Discord (opcional)

Toda vez que um clipe é salvo, o app pode mandar o link automaticamente pra um canal do seu servidor Discord — o próprio Discord mostra o vídeo com player e miniatura direto no chat.

1. No Discord, vá no canal desejado → clique na engrenagem (Editar Canal) → **Integrações** → **Webhooks** → **Novo Webhook**.
2. Dê um nome (ex: "Clipes") e clique em **Copiar URL do Webhook**.
3. No Render (ou no seu `.env` local), adicione a variável `DISCORD_WEBHOOK_URL` com esse link colado.

Pronto — a partir do próximo deploy, todo clipe salvo aparece automaticamente nesse canal. Sem essa variável configurada, os clipes continuam funcionando normalmente, só não são enviados ao Discord.

## Como rodar

```
npm install
npm start
```

Abra `http://localhost:3000`.

- **Transmitir**: clique em "Iniciar transmissão", compartilhe a tela, anote o código.
- **Assistir**: em outra aba/computador, abra "Assistir com um código" e digite o código.
- **Clipar**: enquanto assiste, use os botões "Clipar últimos 30s" ou "Clipar últimos 60s". O clipe é salvo automaticamente e aparece em "Ver clipes salvos".

## Testando pela internet

`getDisplayMedia` só funciona em `localhost` ou HTTPS. Para testar rápido:

```
npx ngrok http 3000
```

Para um link fixo permanente, publique no [Render](https://render.com) (veja instruções que já te passei antes) — não esqueça de configurar as variáveis do Cloudinary lá também.

## Como funciona o clipe (detalhe técnico)

O navegador de quem transmite mantém um único buffer em segmentos WebM completos de aproximadamente 5 segundos, limitado à última janela de ~75 segundos em memória. Os espectadores não gravam nem armazenam cópias: ao clicar em "Clipar", enviam apenas uma solicitação leve pelo WebSocket. O servidor autoriza a solicitação com um identificador temporário e o transmissor envia somente os segmentos necessários. O servidor concatena os arquivos, remove a sobra anterior à janela solicitada, normaliza a saída em até 1080p/30 FPS e envia o MP4 ao Cloudinary. Como cada segmento tem seu próprio cabeçalho e começa em um quadro decodificável, clipes consecutivos não dependem dos timestamps da gravação anterior.

Para controlar CPU, memória, disco e tráfego, apenas um clipe é admitido por vez em cada instância e uploads sem solicitação válida são rejeitados antes de serem gravados. A listagem do Cloudinary possui cache curto e a galeria carrega apenas posters até o usuário iniciar um vídeo. O endpoint `/health` informa quantidade de salas, clipes ativos e tempo de atividade do processo.

## Limitações deste MVP

- Sem TURN server: pode falhar em redes com firewall/NAT restritivo.
- Sem senha na sala.
- A gravação do clipe depende do navegador suportar `MediaRecorder` com WebM/VP8 (funciona bem no Chrome e Edge; pode não funcionar no Safari).
- Plano gratuito do Cloudinary tem limite de armazenamento/banda (geralmente confortável para testes, mas vale acompanhar o painel deles se usarem bastante).
