# CsTraders - Steam Sync

Extensão oficial do [cstraders](https://cstraders.com.br) para Chrome, Edge e Brave.

Ela leva as trades da sua conta Steam para a sua loja no cstraders automaticamente.
Você não precisa mais cadastrar cada trade à mão.

## Como funciona

1. Você entra na Steam neste navegador, como sempre faz.
2. A cada 5 minutos, a extensão olha o histórico de trades da sua conta, aqui
   mesmo no navegador.
3. As trades novas aparecem na sua loja no cstraders.

A extensão não tem tela própria. Você acompanha tudo no cstraders, em
**Configurações → Contas Steam**.

## O que ela não faz

- Não pede nem vê sua senha da Steam.
- Não pede nem vê o código do Steam Guard.
- Não aceita, envia nem cancela trades.
- Não mexe nos seus itens.
- Não olha outros sites nem o que você faz na internet.
- Não manda sua sessão da Steam para lugar nenhum: ela fica no seu navegador.
- Não manda nada para nenhum lugar além do cstraders.

## O que o navegador vai pedir

Ao instalar, o navegador mostra o que a extensão pode acessar:

| O navegador mostra             | Por que a extensão precisa                        |
| ------------------------------ | ------------------------------------------------- |
| Acesso ao site da Steam        | Para saber que você está logado e em qual conta.  |
| Acesso a api.steampowered.com  | Para ler o histórico de trades da conta.          |
| Acesso a login.steampowered.com | Para a Steam renovar sua sessão quando ela vence. A extensão não faz login nem vê sua senha. |
| Acesso ao site do cstraders    | Para enviar as trades para a sua loja.            |

## Seus dados

- **Sua sessão da Steam nunca sai do navegador.** O cstraders não recebe nem guarda
  nenhuma credencial sua.
- A extensão envia só as trades em que você **recebeu** itens: a data, a conta da
  outra ponta e os itens. Trades em que você só enviou itens ficam de fora.
- As trades ficam na sua loja no cstraders e só a sua equipe vê.

Mais detalhes na nossa [Política de Privacidade](https://cstraders.com.br/privacidade#extensao).

## Como instalar

1. Abra a [página da extensão na Chrome Web Store](https://chromewebstore.google.com/detail/lkkgojnfnkgfeggpebnecfhebjflofkh) e clique em
   **Usar no Chrome**. No Edge, aceite *Permitir extensões de outras lojas*.
2. Volte ao cstraders (recarregue a página se ela já estava aberta).
3. Em **Configurações → Contas Steam**, clique em **Atualizar trades** na sua conta.

## Segurança

O código desta extensão é aberto e fica todo aqui, para qualquer pessoa conferir o
que ela faz. São poucos arquivos, sem nada escondido.

Veja [docs/desenvolvimento.md](docs/desenvolvimento.md).
