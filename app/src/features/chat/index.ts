/**
 * Public API for the chat feature.
 *
 * Other modules should import only from this barrel; everything else
 * (MessageBubble, ToolCallCard, MessagePart, MentionTypeahead, hooks)
 * is internal to the feature.
 */
export { ChatView } from './ChatView';
export { ChatThread } from './ChatThread';
export { Composer } from './Composer';
export { EmptyChat } from './EmptyChat';
export {
  ensureActiveChat,
  branchChatFromMessage,
  formatBranchChatTitle,
  messagesThroughBranchPoint,
  deriveChatTitle,
  isDefaultChatTitle,
  maybeRenameChat,
} from './chatLifecycle';
export { InputToken, TokenList, type TokenType } from './InputToken';
export {
  SlashCommandTypeahead,
  SLASH_COMMANDS,
  type SlashCommandDef,
  type SlashCommandTypeaheadRef,
} from './SlashCommandTypeahead';
export {
  SlashCommandOptionPicker,
  type SlashCommandOption,
  type SlashCommandOptionPickerRef,
} from './SlashCommandOptionPicker';
