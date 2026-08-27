# MVP - Transmissão de tela com código

Protótipo funcional: quem transmite compartilha a tela e recebe um código de 4 letras.
Quem assiste digita o código no navegador e o vídeo chega via WebRTC (baixa latência, ~ menos de 1s na mesma rede).

## Como rodar

1. Instale o [Node.js](https://nodejs.org) (versão 18 ou mais recente), se ainda não tiver.
2. Abra um terminal (PowerShell/CMD) na pasta do projeto e rode:

   ```
   npm install
   npm start
   ```

3. Abra `http://localhost:3000` no navegador (Chrome ou Edge recomendados).
   - Em **"Iniciar transmissão"**, clique em "Compartilhar tela", escolha a tela/janela e anote o código gerado.
   - Em outra aba/computador, abra **"Assistir com um código"** e digite o código.

## Testando com outro computador na mesma rede

- Descubra o IP local da máquina que roda o servidor (`ipconfig` no Windows, procure "Endereço IPv4").
- No outro computador, acesse `http://SEU-IP:3000` em vez de `localhost`.

## Testando pela internet (fora da rede local)

`getDisplayMedia` (captura de tela) só funciona em `localhost` ou em conexões **HTTPS**. Para testar rapidamente com pessoas fora da sua rede, exponha o servidor com um túnel, por exemplo:

```
npx ngrok http 3000
```

Isso gera uma URL `https://...ngrok-free.app` que já resolve o requisito de HTTPS — use essa URL tanto para transmitir quanto para assistir.

## Limitações deste MVP (esperadas, para evoluir depois)

- Sem TURN server: em redes com firewall/NAT restritivo (comum em redes corporativas), a conexão pode falhar. Para produção, adicionar um servidor TURN (ex: Twilio, Metered, ou self-hosted com `coturn`) resolve isso.
- Topologia em estrela (um upload do transmissor por espectador): funciona bem até ~10 espectadores. Para escalar além disso, seria necessário um SFU (ex: LiveKit, mediasoup).
- Código de sala não expira e não tem senha — qualquer pessoa com o código pode assistir.
- Sem reconexão automática caso a internet caia.
