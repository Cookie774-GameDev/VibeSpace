# VibeSpace Slash-Command Parity Design

## Objective

Preserve every command and intentional alias in PR31 Section 20 while making
ownership explicit. A command must resolve to a VibeSpace behavior or a
VibeSpace-built instruction transported through OpenCode; raw VibeSpace slash
syntax must never be delegated to OpenCode for interpretation.

## Authority model

`slashCommandRouting.ts` is the central, UI-independent authority:

```ts
type CommandOwner =
  | 'vibespace-ui'
  | 'vibespace-context'
  | 'vibespace-tool'
  | 'opencode-agent';
```

Each canonical Section 20 command has one frozen route containing its owner and
execution kind. Aliases normalize before lookup. The typeahead imports the
same alias authority so discovery and execution cannot drift.

The classifier does not execute side effects. `Composer` remains the
VibeSpace-owned dispatcher and uses the classification as a hard gate:

- unknown commands produce the existing local help message;
- local state/navigation commands execute locally;
- context commands create bounded references or attachments locally;
- agent commands may send only the remainder/instruction through OpenCode;
- no recognized VibeSpace command sends its raw slash token to OpenCode.

## Parity repairs

- Restore `/themes` as an intentional alias of `/theme`.
- Convert `/schedule <request>` into a VibeSpace Schedule reference plus the
  natural-language request instead of forwarding raw slash syntax.
- Make typed `/plug` open the connected-plugin picker.
- Make typed `/skills <id-or-name>` select a real catalog skill; bare `/skills`
  continues to present the catalog.
- Make `/md <kind> <brief>` select a supported document kind and transport the
  existing structured Markdown creation instruction through OpenCode.
- Require `/attach` to receive a safe absolute path. Missing, relative, or
  malformed paths receive local help and are never attached.

## Verification

The automatic command matrix freezes every canonical command, owner, execution
kind, and alias. Focused unit tests cover normalization, unknown commands,
raw-slash forwarding prevention, Markdown parsing, and absolute attachment
validation. Existing Composer/typeahead tests provide regression evidence for
mode, reference, picker, undo/redo, model, effort, token mode, and attachment
workflows. Typecheck, production build, formatting, and diff checks are release
gates.

Manual review follows the same matrix and records whether each command reaches
its local picker/state/reference/action or its bounded OpenCode instruction.
