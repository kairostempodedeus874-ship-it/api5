# Servidor de WhatsApp — Kairós (v5.5.0)

Este é o "motor" que mantém o WhatsApp da empresa conectado 24 horas por dia.
Ele **envia** as notificações (cobrança do dia, confirmação de pagamento) e
guarda o comprovante técnico de entrega de cada mensagem.

> 🚫 **A partir da v5.5.0 ele NÃO lê, NÃO interpreta e NÃO responde mensagens
> recebidas.** Não é chatbot e não é atendimento automático. Ver
> [seção 4.1](#41-modo-somente-envio-v550).

> ⚠️ **Ele precisa ficar ligado o tempo todo e precisa de um disco próprio.**
> Hospedagens que "dormem" por inatividade ou que apagam o disco a cada deploy
> (Vercel, Netlify, Cloudflare, funções serverless) **não servem** — a sessão do
> WhatsApp morre e você precisa escanear o QR Code de novo toda hora.

---

## Novidade da v5.5.0 — o balão "Aguardando mensagem" e a causa raiz

O sintoma relatado: o painel dizia **enviado**, o seu celular recebia normal,
mas o aparelho do **cliente** ficava eternamente no balão cinza com o relógio.

O balão é o WhatsApp do cliente dizendo *"recebi um envelope e não consigo
abrir"*. Eram **três causas**, todas no nosso lado:

| # | Causa real | Como foi corrigido |
|---|---|---|
| 1 | Biblioteca antiga (`^6.7.0`). Essa faixa é anterior à migração do WhatsApp para endereçamento **LID**. A mensagem era cifrada para `<numero>@s.whatsapp.net` enquanto o aparelho do cliente já esperava um envelope endereçado ao LID dele. | Versão **fixa em 6.7.20** (com LID). Não use `^` — o `^` foi justamente o que instalou uma versão quebrada. |
| 2 | Envio para `@lid` sem ter a sessão de criptografia daquele LID (`found.jid \|\| found.lid`). Isso gera o mesmo envelope ilegível. | `resolveJid()` agora usa **só o JID do número**. `@lid` nunca é destino; aparece apenas como diagnóstico. |
| 3 | O cache das mensagens enviadas era em **memória**. Quando o cliente pedia a mensagem de volta (é assim que o balão destrava), o servidor precisava responder a original — mas todo deploy apagava o cache. | Cache agora é gravado em **disco** (`<sessão>/sent-cache/`), validade de **24h**, e o handler `getMessage` devolve a mensagem original. Nunca devolve vazio. |

Outros dois pontos que também geravam o balão e agora estão fechados:

- **Dois serviços no mesmo disco.** Dois processos usando a mesma sessão ficam
  corrompendo as chaves um do outro em loop. Agora existe uma trava
  (`instance.lock`) e o diagnóstico avisa `instancia_conflitante`.
- **`sendPresenceUpdate("composing")` antes de cada envio.** Era um "digitando…"
  que ficava pendurado quando a mensagem não concluía, exatamente o quadro do
  balão. Removido: modo somente envio não sinaliza presença.

### Por que a mensagem que já travou não se conserta sozinha

Aquilo foi entregue corrompido no aparelho do cliente. Nenhum código nosso
"volta atrás" numa mensagem já recebida. Depois do deploy, **mensagem nova chega
normal** — é esse o teste que vale.

### E se voltar a acontecer?

1. Abra `SUA_URL/api/diagnostico` e confira `baileys_version` (precisa ser
   6.7.18 ou maior) e `instancia_conflitante` (precisa ser `null`).
2. Aba **Conexão** → **Renovar chaves de conversa** (apaga só `session-*.json`,
   não pede QR Code, não derruba a conexão).
3. Só se as duas coisas não resolverem: **Reconectar do zero** (aí sim pede QR).

---

## Novidade da v5.3 — nenhuma variável para preencher

Antes era preciso preencher 5 variáveis na hospedagem, e bastava errar uma para
o deploy "virar" mas nada funcionar. Agora o servidor se vira sozinho **e não usa
nenhuma chave secreta**:

| Antes você digitava | Agora |
|---|---|
| `WPP_API_KEY` | já vem com padrão que combina com o painel |
| `WPP_AGENT_SECRET` | já vem com padrão que combina com a IA |
| `SUPABASE_URL` | já vem apontando para o Backend certo |
| `SUPABASE_ANON_KEY` | **não é mais usada** |
| `WPP_AUTH_DIR` | **o servidor encontra o disco sozinho** |
| `WPP_PUBLIC_URL` | **detectada sozinha** |
| `SUPABASE_SERVICE_KEY` | **não é mais necessária** |

**Por que a chave de serviço saiu:** ela é a chave mestra do banco e o Backend
não a expõe (nem deveria). Em vez de copiar uma chave secreta para o painel da
hospedagem, o servidor pede as consultas para a função `wpp-agente`, que já roda
dentro do Backend com permissão total e é autenticada pela chave do agente. Isso
deixa o servidor **mais seguro** e com a **mesma permissão** de antes.

Ou seja: crie o serviço, espere ficar Live e pronto. Se algo falhar, abra
`SUA_URL/api/diagnostico` e ele diz em português o que está faltando.

---

## 1. Qual hospedagem usar

| Plataforma | Custo mensal | Dorme? | Disco | Veredito |
|---|---|---|---|---|
| **Render (plano Starter)** | ~US$ 7,25 (≈ R$ 39) | Não | Sim (US$ 0,25/GB) | **Padrão do projeto.** Só cliques, sem terminal |
| Railway | US$ 5 (≈ R$ 27) | Não | Sim | Funciona igual, um pouco mais barato |
| VPS (Hetzner/Contabo) | €4–5 (≈ R$ 25–30) | Não | Sim | Mais barato no longo prazo, exige terminal |
| Oracle Cloud Free | R$ 0 | Não | Sim | Existe plano gratuito, cadastro chato e máquina lenta |
| Fly.io | ~US$ 3,84 (≈ R$ 21) | Não | Sim | Foi a origem dos erros de porta. **Não recomendado** |

**Escolha do projeto: Render, plano Starter.** Cumpre os três requisitos de
produção (processo sempre vivo, disco persistente, reinício automático) e é o
mais difícil de errar.

Sobre "conexão boa": o que pesa não é o país do servidor, e sim ele nunca dormir,
ter disco e ficar perto do Backend. Use a região **virginia** (EUA, costa leste),
a mais próxima do Brasil (~120 ms). A conversa com o WhatsApp é feita pelos
servidores do WhatsApp, não pelo Brasil.

Custos extras possíveis: disco de 1 GB (US$ 0,25 — a sessão ocupa poucos MB) e
tráfego de saída (volume ínfimo).

---

## 2. Publicar no Render (caminho padrão, ~10 minutos)

Tudo pelo navegador, sem terminal. Uma vez só.

1. **GitHub.** Suba esta pasta em um repositório novo (pode ser privado).
   `package.json`, `Dockerfile` e `render.yaml` precisam ficar na **raiz** do
   repositório, não dentro de uma subpasta.
2. **Criar o serviço.** render.com → **New** → **Blueprint** → conecte o GitHub
   → escolha o repositório. O Render lê o `render.yaml` e já monta tudo: imagem
   Docker, plano, disco e checagem de saúde.
3. **Revisar.** Confirme na tela de revisão:
   - plano **Starter** (o Free **não** serve)
   - disco montado em **`/var/data`**, 1 GB
   - região **virginia**
4. **Variáveis.** Não precisa preencher nenhuma: o `render.yaml` já traz
   `TZ=America/Sao_Paulo` e o resto vem do código.
   **Não cadastre `PORT`**, não precisa de `SUPABASE_SERVICE_KEY` e nem de
   `WPP_AUTH_DIR`.
5. **Deploy.** O primeiro build leva de 3 a 8 minutos (instala o Baileys e
   compila dependências). Espere o status virar **Live**.
6. **Endereço.** Aparece no topo do serviço: `https://seu-servico.onrender.com`.
7. **Confira.** Abra `https://seu-servico.onrender.com/api/diagnostico`. Você
   deve ver `"ok": true`, `"pasta_persistente": true` e `"permissoes_banco":
   "completa"`. Depois cole só o endereço na aba **Conexão** do painel.

> Por que Starter e não Free: no Free o serviço hiberna após 15 min sem acesso e
> não tem disco. Hibernou = sessão caiu = QR Code de novo. Não existe contorno.

---

## 2.1 Alternativa: Railway (também funciona bem)

1. railway.app → **New Project** → **Deploy from GitHub repo** → escolha o
   repositório. Ele encontra o `Dockerfile` sozinho.
2. **Settings → Region:** `us-east4 (Virginia)`.
3. **Settings → Volumes → Add Volume:** montagem em **`/data`**.
4. **Variables:** nenhuma obrigatória. Não cadastre `PORT` nem `SUPABASE_SERVICE_KEY`.
5. **Settings → Networking → Generate Domain.**
6. Abra `/api/diagnostico` e confirme `"ok": true`.

Diferença única: aqui o disco é `/data`; no Render é `/var/data`. Como o servidor
procura os dois sozinho, você não precisa configurar nada.

---

## 3. Publicar em VPS próprio

```bash
# na VPS, com Docker instalado
docker compose up -d --build
```

O `docker-compose.yml` já cria o volume e reinicia o serviço sozinho (a pasta da
sessão é detectada automaticamente). Para HTTPS, coloque um proxy (Caddy ou
Nginx) na frente apontando para a porta 8080.

---

## 4. Variáveis de ambiente

| Variável | Obrigatória | O que é |
|---|---|---|
| `TZ` | recomendada | `America/Sao_Paulo` para os horários saírem certos. |
| `WPP_MODO` | não | `envio` (padrão) = só envia. `atendimento` = religa a leitura/resposta pela IA. |
| `PORT` | não | Porta HTTP. Deixe em branco — a hospedagem injeta a sua. O servidor também escuta em 3000 e 3001 por segurança. |
| `WPP_API_KEY` | não | Senha que o painel usa para falar com este servidor. Tem padrão compatível. |
| `WPP_AGENT_SECRET` | não | Chave da função `wpp-agente` (IA). Tem padrão compatível. |
| `SUPABASE_URL` | não | Endereço do Backend. Tem padrão correto. |
| `WPP_AUTH_DIR` | não | Pasta da sessão. **Detectada sozinha.** Só use para forçar um caminho. |
| `WPP_PUBLIC_URL` | não | URL pública. Detectada sozinha no Render/Railway/Fly. |

Não existe mais nenhuma chave secreta para colar no painel da hospedagem: o
acesso ao banco é feito pela função `wpp-agente` dentro do Backend.

---

### 4.1 Modo somente envio (v5.5.0)

O padrão de fábrica é `WPP_MODO=envio`. Nesse modo:

| Faz | Não faz |
|---|---|
| Envia cobrança, confirmação e teste | Não abre o conteúdo de mensagem recebida |
| Valida o número antes de enviar | Não interpreta conversa |
| Guarda o ID real de cada mensagem | Não responde cliente nenhum |
| Registra `enviado` / `entregue` / `lido` / `falhou` | Não cria chatbot nem atendimento |
| Reconecta sozinho | Não executa comando com base no que o cliente escreve |

A única coisa "recebida" que continua sendo lida é o **recibo técnico**
(`messages.update`), que informa se a nossa mensagem foi entregue. Ele não tem
nenhum conteúdo de conversa.

Para religar o atendimento por IA, defina `WPP_MODO=atendimento`. O modo antigo
foi preservado no código, mas ele não recebe mensagem nenhuma com o padrão novo.

---

## 5. Como saber se está tudo bem

- `SUA_URL/api/diagnostico` → diz em português o que está faltando, se algo
  estiver. Este é o primeiro lugar para olhar quando algo não funciona.
- `SUA_URL/api/health` → resposta rápida usada pela hospedagem (deve ter
  `"ok":true`).
- Na aba **Conexão** do painel, o diagnóstico mostra versão, tempo no ar, sessão
  salva, contagem de mensagens e a data da última cobrança.
- Configure um monitor gratuito (UptimeRobot, BetterStack) apontando para
  `/api/health` a cada 5 minutos, com alerta por e-mail.

O que o servidor já garante sozinho:
- **Sem mensagem duplicada**: cada parcela é "reservada" no banco antes do envio.
- **Cobrança não se perde**: se o serviço estiver fora do ar às 11h, ele envia
  assim que voltar (e só uma vez por dia, mesmo reiniciando várias vezes).
- **Reconexão automática** com espera progressiva.
- **Fila do atendente humano** entregue em até 5 segundos.
- **Mensagem não fica "Aguardando mensagem"**: a biblioteca está fixada numa
  versão com suporte a LID, o destino é sempre o JID do número (nunca `@lid`
  sozinho) e as mensagens enviadas ficam guardadas **em disco por 24h**, então
  quando o celular do cliente pede o conteúdo de volta o servidor reenvia a
  original. Além disso, as chaves de conversa são renovadas automaticamente na
  primeira subida desta versão e, se voltar a acontecer, o botão **Renovar
  chaves de conversa** (aba Conexão) resolve em segundos — **sem QR Code**.
- **Prova de entrega**: cada envio gera um `mensagem_id_wpp` (o ID real no
  WhatsApp) e o servidor escuta os recibos: `enviado` → `entregue` → `lido`, ou
  `falhou` com o motivo. O painel não mostra "enviado" por ter executado uma
  função — mostra pelo retorno real da plataforma.
- **Sem duplicidade em retentativa**: o ID da mensagem é gerado do nosso lado e
  reaproveitado na nova tentativa, então o WhatsApp descarta a segunda via.
- **Desligamento limpo**: em deploy/reinício ele fecha a sessão antes de morrer,
  evitando arquivo de credencial corrompido.

---

## 6. Backup e volta atrás

**Backup da sessão (opcional):** no Render, o disco pode ser baixado em
**Disks → seu disco**. No Railway, em **Settings → Volumes → Download**. No VPS,
basta copiar a pasta da sessão. Se perder a sessão, escaneie o QR Code
novamente — nenhum dado de cliente é perdido, porque tudo fica no Backend.

**Voltar para a hospedagem anterior:** este servidor não depende de nenhuma
plataforma específica. Publique esta mesma pasta no host antigo e cole a URL nova
na aba **Conexão**. Nada muda no código.

**Nunca apague o serviço antigo antes de o novo responder** em `/api/health`
e de o botão **Enviar teste** chegar no seu celular.

---

## 7. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| Build falha no Render | `Dockerfile` fora da raiz ou build sem memória | Veja **Logs**; confira a raiz do repositório |
| "Live" mas a URL não responde | Disco não montado em `/var/data` | Confira em **Disks** e abra `/api/diagnostico` |
| Conecta e cai em minutos | Sem disco (sessão não persiste) | `/api/diagnostico` aponta `pasta_persistente: false` — crie o disco |
| Serviço "dormiu" | Plano Free | Mude para **Starter** |
| QR não aparece | Serviço ainda subindo | Espere o deploy ficar Live e clique em Conectar |
| Conectado mas não responde | Falta a chave da IA no Backend | Cadastre `OPENAI_API_KEY` no Backend |
| Cobrança não saiu hoje | Fora do horário ou sem conexão | Veja `last_cobranca` no diagnóstico do painel |
| Cliente vê o balão cinza "Aguardando mensagem" | Uma das três causas: (1) biblioteca do WhatsApp desatualizada (`baileys_version` abaixo de 6.7.18), (2) envio para `@lid` sem sessão de criptografia, (3) cache de reenvio perdido. Some-se a isso chave de conversa fora de sincronia ou dois processos no mesmo disco | Veja `baileys_version` e `instancia_conflitante` em `/api/diagnostico`. Depois, aba **Conexão** → **Renovar chaves de conversa** (apaga só `session-*.json`, reconecta em segundos, **não pede QR Code**). Na v5.5.0 a renovação já roda sozinha na primeira subida |

---

## 8. Portas (só se algum dia der "Request failed")

O servidor escuta em **8080, 3000 e 3001** ao mesmo tempo, e usa
`process.env.PORT` quando a plataforma injeta uma porta. Isso cobre Render,
Railway, Fly e VPS sem nenhuma configuração. Se a URL ficar muda com o serviço
ligado, confira se alguém cadastrou `PORT` manualmente com um valor errado e
remova essa variável.

---

## 9. Testes — o que foi verificado e o que depende de você

### Verificações automáticas (rodam sem enviar nada)

| # | O que garante | Como conferir |
|---|---|---|
| 1 | Número inválido é barrado **antes** de gastar chamada | `POST /api/verificar-numero` com número errado devolve o motivo (falta DDI, DDD inválido, celular sem o 9) |
| 2 | Versão da biblioteca correta | `/api/diagnostico` → `baileys_version >= 6.7.18` e `baileys_atualizado: true` |
| 3 | Só uma instância no disco | `/api/diagnostico` → `instancia_conflitante: null` |
| 4 | Cache de reenvio funcionando | `/api/status` → `cache_envio` maior que 0 depois do primeiro envio |
| 5 | Modo somente envio ativo | `/api/diagnostico` → `modo: "somente_envio"` |
| 6 | Pagamento duplicado não gera mensagem duplicada | Duas chamadas seguidas de varredura: só a primeira "reserva" a parcela (`wpp_confirmacao_enviada`) e as demais são ignoradas |
| 7 | Falha de envio fica registrada | Mensagem para número sem WhatsApp aparece como `falhou` com o motivo, no histórico |

### Testes reais (precisam de você)

Estes só você pode fechar, porque dependem de um celular de verdade:

1. Aba **Conexão** → **Enviar teste** → digite **o seu próprio número** com DDD.
2. Confirme que a mensagem **aparece legível** no seu WhatsApp (não no balão).
3. Abra `/api/status` e veja `messages_sent` subir; depois de alguns segundos,
   `messages_delivered` deve subir também (isso é o recibo de entrega).
4. Simule um pagamento novo e veja a confirmação chegar no celular do cliente.
5. Mande uma mensagem **do seu celular** para o número da empresa e confirme que
   **nada acontece** — nenhuma leitura, nenhuma resposta. Isso prova o item 3.

> Nenhum resultado de teste foi inventado aqui. Os testes automáticos provam
> validação, deduplicação, rastreio e modo somente envio. A **entrega visível no
> celular do cliente** só a etapa acima comprova.