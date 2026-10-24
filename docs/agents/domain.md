# Domain Docs

Como as skills de engenharia consomem a documentação de domínio deste repo.

## Leia antes de explorar

- **`CONTEXT.md`** na raiz.
- **`docs/adr/`**: leia os ADRs que tocam a área em que vai mexer.

Se algum não existir, siga em silêncio. A skill `/domain-modeling` os cria quando termos ou decisões forem resolvidos.

## Estrutura

Single-context:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-integracao-acp-sdk-patches.md
│   └── 0002-collab-fora-de-escopo.md
└── docs/
```

## Use o vocabulário do glossário

Quando a saída nomear um conceito do domínio (título de issue, proposta de refactor, hipótese, nome de teste), use o termo como definido em `CONTEXT.md`. Não derive para sinônimos.

Se o conceito não estiver no glossário, ou você está inventando linguagem que o projeto não usa, ou há uma lacuna real: registre para `/domain-modeling`.

## Sinalize conflito com ADR

Se a saída contradiz um ADR existente, diga explicitamente em vez de sobrescrever:

> _Contradiz ADR-0001 (integração ACP + SDK + patches), mas vale reabrir porque…_
