# Ponto Simples (SaaS)

Controle de ponto multiempresa, leve e direto:

- **Backend:** Node.js puro, **zero dependências** (`npm install` não é necessário). Banco SQLite embutido do próprio Node (`node:sqlite`).
- **Frontend:** HTML + CSS + JavaScript puro, sem framework e sem etapa de build.

## Como rodar

Requer Node.js **22.13 ou superior**.

```bash
node server.js          # inicia em http://localhost:3000
node server.js --demo   # cria uma empresa de exemplo se o banco estiver vazio (apenas para testes)
```

Logins da demo: `admin@demo.com` (administrador) e `ana@demo.com` (colaboradora), senha `demo1234`.

Variáveis de ambiente:

| Variável | Uso |
| --- | --- |
| `PORT` | porta (padrão 3000) |
| `DATA_DIR` | pasta do banco `ponto.db` (padrão `./data`) |
| `NODE_ENV=production` | marca o cookie de sessão como `Secure` (exige HTTPS) |
| `TRUST_PROXY=1` | usa `X-Forwarded-For` para o limite de tentativas, quando atrás de proxy reverso |

## Como funciona

- **Criar conta da empresa:** cada cadastro cria uma empresa (tenant) e o seu primeiro administrador.
- **Administrador:** cadastra colaboradores (e-mail + senha inicial, jornada, dias de trabalho), vê a apuração de todos, corrige marcações, abona dias, imprime e exporta CSV.
- **Colaborador:** bate o próprio ponto e consulta a própria apuração (somente leitura).
- **Bater ponto:** registra a hora do servidor, no fuso da empresa, na próxima marcação livre do dia (entrada, saída para intervalo, retorno, saída). Vale sempre para quem está logado.

### Regras de cálculo

- Previsto = soma dos dois períodos da jornada, nos dias de trabalho a partir do início da apuração.
- Saldo do dia = trabalhado − previsto. Positivo conta como extra.
- Atraso = minutos após a entrada prevista, com tolerância de 5 minutos (`TOLERANCE` em `public/app.js`).
- Dia de trabalho passado sem marcação = falta. O dia de hoje só entra no saldo após as quatro marcações.
- Abono zera o saldo negativo do dia.

## Segurança já incluída

- Isolamento entre empresas: toda consulta é filtrada pela empresa da sessão; o cliente nunca informa o tenant.
- Autorização verificada a cada requisição (negado por padrão; perfis admin/colaborador).
- Senhas com scrypt + salt; sessão em cookie `HttpOnly` + `SameSite=Strict`, com apenas o hash do token no banco.
- Proteção contra CSRF (cookie Strict + exigência de JSON + verificação de origem).
- Consultas SQL parametrizadas e validação de todos os campos de entrada.
- Limite de tentativas de login e de cadastro; resposta de login não revela se o e-mail existe.
- Cabeçalhos de segurança (CSP restrita, `X-Frame-Options`, `nosniff`).

## Antes de colocar em produção

Itens que ficaram de fora de propósito, para manter o projeto simples:

1. **HTTPS:** rode atrás de um proxy reverso (Caddy, nginx) com TLS e defina `NODE_ENV=production` e `TRUST_PROXY=1`.
2. **Recuperação de senha e verificação de e-mail:** não há envio de e-mail. Hoje o administrador redefine a senha do colaborador; o administrador não tem como recuperar a própria.
3. **Planos e cobrança:** não há assinatura nem limite por plano.
4. **MFA** para administradores e **log de auditoria** das correções de ponto.
5. **Escala:** o SQLite e o limite de tentativas em memória atendem a uma única instância. Para várias instâncias, migre para PostgreSQL (com Row-Level Security) e um limitador compartilhado.
6. **Backup** de `data/ponto.db`.
7. **LGPD:** termos de uso, política de privacidade e exclusão de dados da empresa.
8. **Validade legal:** não é um REP homologado (Portaria MTP 671/2021); confirme os requisitos antes de usar como registro oficial.
9. O `node:sqlite` ainda emite um aviso de "experimental" no Node 22.

## Estrutura

```
server.js          API REST, autenticação e arquivos estáticos
public/index.html  página única (login + apuração)
public/style.css   estilos
public/app.js      lógica da tela e cálculos
data/ponto.db      banco SQLite (criado automaticamente)
```

## API

| Método | Rota | Quem | Descrição |
| --- | --- | --- | --- |
| POST | `/api/signup` | público | cria empresa + administrador |
| POST | `/api/login`, `/api/logout` | — | sessão |
| GET | `/api/me` | logado | usuário, empresa e data atual |
| POST | `/api/me/password` | logado | troca a própria senha |
| POST | `/api/punch` | logado | bate o próprio ponto |
| GET | `/api/employees` | logado | admin: todos da empresa; colaborador: só ele |
| POST | `/api/employees` | admin | cria colaborador |
| PUT / DELETE | `/api/employees/:id` | admin | edita / exclui |
| GET | `/api/employees/:id/records?month=AAAA-MM` | admin ou o próprio | marcações do mês |
| PUT | `/api/employees/:id/records` | admin | corrige marcações |
