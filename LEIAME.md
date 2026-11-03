# MyFinance

Controle das faturas, entradas e reservas. Você envia o CSV do cartão, o app categoriza e mostra quanto resta em cada categoria, quanto dá para gastar por semana, de onde veio cada gasto e quanto está guardado. Funciona no PC e no iPhone, com os dados no Supabase.

## 1. Banco de dados (Supabase), uns 10 minutos

1. Crie uma conta em supabase.com e um projeto novo, na região **South America (São Paulo)**. Guarde a senha do banco.
2. No projeto, abra **SQL Editor → New query**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**. Pode rodar de novo no futuro sem perder dados.
3. Em **Authentication → URL Configuration**, coloque em *Site URL* o endereço que o site vai ter (passo 2), por exemplo `https://SEU-USUARIO.github.io/caixa/`.
4. Em **Project Settings → API** (ou **Data API**), copie a *Project URL* e a chave *anon public* e cole as duas em `js/config.js`.

A chave *anon* pode ficar pública: os dados só abrem para quem está logado, e cada pessoa só enxerga as próprias linhas.

## 2. Site (GitHub Pages)

1. Crie um repositório chamado `caixa` e envie todos os arquivos, mantendo as pastas (`css`, `js`, `icons`, `supabase`).
2. Em **Settings → Pages**, escolha *Deploy from a branch*, branch `main`, pasta `/ (root)`.
3. Em um ou dois minutos o site fica em `https://SEU-USUARIO.github.io/caixa/`.

**Nunca coloque dados financeiros no repositório** (CSV, valores, prints). Ele é público; os dados vivem só no Supabase.

## 3. Primeiro acesso

1. Abra o site, preencha e-mail e senha e toque em **Criar conta**. Confirme pelo link que chega no e-mail e entre.
2. Rode o arquivo `dados-pessoais.sql` (que vai à parte, fora do repositório) no SQL Editor, trocando pelo seu e-mail. Ele já preenche fixos, entradas e as regras das lojas onde você compra. Depois recarregue o app.
3. Em **Ajustes**, confira os cartões (o Nubank fecha dia 3 e vence dia 10; preencha o Inter quando souber) e os tetos.
4. Toque em **Enviar fatura** e escolha o CSV.
5. **Feche a porta:** em Supabase → **Authentication → Sign In / Providers**, desligue *Allow new users to sign up*. Assim ninguém mais cria conta no seu app.

## 4. No iPhone

Abra o site no Safari → botão Compartilhar → **Adicionar à Tela de Início**. Ele abre como app, e o login fica salvo.

## Como funciona

- **Sincronização:** PC e celular leem e escrevem no mesmo banco. Com o app aberto nos dois, o que muda num aparece no outro em um ou dois segundos.
- **Enviar fatura:** o app reconhece o formato do Nubank sozinho. Para outros bancos, ele lê qualquer CSV com data, descrição e valor, e você escolhe de qual cartão é.
- **Não duplica:** pode reenviar a fatura aberta todo domingo. Cada compra tem uma impressão digital (cartão, data, descrição, valor e ordem no dia); o que já está no app é pulado, e o banco recusa repetidas mesmo se algo falhar. O app também segura compras cuja descrição ou valor mudou entre um envio e outro, e avisa se a fatura parecer já enviada com outro cartão.
- **Rubricas:** as da planilha (Alimentação, Mercado, Bem-Estar e Saúde, Casa, Despesas Pessoais, Educação, Lazer e Entretenimento, Pequenos gastos, Transporte, Viagem). Quem usava a versão anterior é migrado sozinho no primeiro acesso.
- **O mês (Painel):** entradas, fixos e a fatura que vence no mês, com a sobra. "Editar valores" muda salário e vintena; "+ Recebimento" registra um avulso (13º, freela). Cada fixo tem uma rubrica; "marcar pago" lança o pagamento por Pix. Um pagamento lançado à mão com o nome do fixo (ou o mesmo valor, na mesma rubrica) também conta como pago, sem somar duas vezes.
- **Teto x fixo:** o teto de cada rubrica é só a parte variável. Os fixos daquela rubrica somam por cima (Casa = teto de luz e internet + aluguel).
- **Sem categoria:** aparecem no aviso **Classificar** e no filtro "Sem categoria" em Gastos. Ao classificar com "Lembrar para as próximas" marcado, o app cria a regra.
- **+ (Lançar):** gasto à mão (Pix, débito, dinheiro, outro cartão, com parcelas) ou entrada avulsa.
- **Entradas:** em Ajustes → Entradas. O app calcula as datas do salário (5º dia útil) e da vintena (dia 20, adiantada se cair em fim de semana ou feriado). Ao confirmar, você ajusta o valor que caiu.
- **Reservas:** reserva de emergência (meta automática de 6 meses do seu custo), caixinhas e investimentos. Os saldos são atualizados à mão.
- **Backup:** Ajustes → **Exportar tudo** baixa um arquivo com todos os seus dados.

## Bom saber

- Sem internet, o app não salva: ele mostra um erro em vez de fingir que salvou.
- No plano gratuito, o Supabase pausa projetos parados por cerca de 7 dias. Usando todo domingo, isso não acontece. Se pausar, é só reativar no painel.
- Feriados considerados nos dias úteis: os nacionais, mais Carnaval e Corpus Christi (bancos fechados). Feriados municipais ou estaduais não entram.
- Todos os gastos entram no ciclo do cartão principal (Nubank) pela data da compra, inclusive os do Inter e os lançados à mão.

## Arquivos

- `index.html`, `css/styles.css`: a interface
- `js/logic.js`: leitura do CSV, regras, ciclos, vencimentos, dias úteis e números das telas (sem tela, sem banco)
- `js/app.js`: telas e conexão com o Supabase
- `js/config.js`: endereço e chave do seu projeto
- `supabase/schema.sql`: tabelas, permissões e tempo real do banco
