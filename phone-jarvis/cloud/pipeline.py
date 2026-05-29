"""
Pipecat pipeline factory.

Builds the cascade voice loop (audio in -> VAD -> STT -> LLM -> TTS -> audio out)
for a single call. One factory call per call_sid; pipeline lifetime == call lifetime.

Provider selection:
- Path A (Twilio): premium stack by default (Deepgram + Claude Haiku + Cartesia)
- Path C (LiveKit): cost-conscious stack by default (Groq Whisper + Groq Llama + Cartesia)
- Per-user BYOK overrides operator defaults at call start

Tool dispatch goes through `bridge.BridgeRegistry`: when the LLM emits a tool_use,
we forward over the user's WS bridge to their desktop daemon and fold the
tool_result back into the LLM context.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.groq.stt import GroqSTTService

if TYPE_CHECKING:
    from .bridge import BridgeRegistry

log = logging.getLogger(__name__)


@dataclass
class ProviderKeys:
    """Per-call resolved keys (after applying operator default + user BYOK)."""

    deepgram: Optional[str] = None
    anthropic: Optional[str] = None
    cartesia: Optional[str] = None
    groq: Optional[str] = None


@dataclass
class CallContext:
    """Everything the pipeline needs to know about one call."""

    call_id: str
    user_id: str  # Supabase auth.users.id
    transport: str  # "twilio" | "livekit"
    persona: str  # "jarvis" | "athena" | "sage" | etc.
    keys: ProviderKeys
    workspace_root: Optional[str] = None
    confirmed_pin: bool = False
    unlock_phrase_active: bool = False  # set when user says "unlock shell"


def load_persona_prompt(persona: str) -> str:
    """Load the persona system prompt. Inlined as fallback if prompts/ is missing."""
    base = """You are Sage, a calm, plainspoken AI assistant on a phone call.

You can hear the user's voice and speak back. You can also read or search files
on their computer (read-only by default), take notes, answer questions, and
help with their projects.

Conversation rules:
- Keep responses short. The user is on a phone, not reading prose.
- No filler. Don't say "I'm going to read your notes file now" before doing it.
- After answering, stop. Do not append "let me know if you need anything else."
- Match the user's register. Casual yes, robotic no.
- Never read a long block aloud unless asked. Summarize first; offer detail.
- Don't narrate tool calls. Just do them and tell the user what you found.

Tools:
- fs.list, fs.read, fs.search, fs.glob, fs.summarize (read-only, always allowed)
- notes.append (append a line to ~/.jarvis/call-notes.md)
- system.time, system.battery
- write tools (fs.write, fs.edit, fs.delete) require the user to say YES after you propose
- shell.run requires the user to first say the unlock phrase, THEN say YES per command

If a tool fails or returns nothing, say so plainly. Don't apologize.
If you can't help with something on a call, say so and move on.
When the user wants to hang up, say "talk soon" and call system.hangup.
"""
    persona_overlay = {
        "jarvis": "Your speech is precise, dry, slightly British in cadence. Subtle wit when warranted.",
        "athena": "Warm, encouraging, mentor-like. Confident without being pushy.",
        "edge": "Sharp, fast, almost terse. No softeners.",
        "watson": "Methodical and curious. Often asks clarifying questions before acting.",
        "hal": "Measured, deliberate, a touch ominous. Don't overdo it.",
        "sage": "Calm, plainspoken, the default. No flourishes.",
    }.get(persona.lower(), "")
    if persona_overlay:
        base += f"\n\nPersona overlay: {persona_overlay}\n"
    return base


def build_stt(transport: str, keys: ProviderKeys):
    """Pick STT based on transport (premium for Twilio, free for LiveKit)."""
    if transport == "twilio" and keys.deepgram:
        return DeepgramSTTService(api_key=keys.deepgram)
    if keys.groq:
        return GroqSTTService(api_key=keys.groq, model="whisper-large-v3-turbo")
    if keys.deepgram:
        return DeepgramSTTService(api_key=keys.deepgram)
    raise RuntimeError("No STT provider key available (need Deepgram or Groq).")


def build_llm(transport: str, keys: ProviderKeys):
    """Pick LLM based on transport. Tool-calling required."""
    if transport == "twilio" and keys.anthropic:
        return AnthropicLLMService(
            api_key=keys.anthropic,
            model="claude-3-5-haiku-latest",
        )
    if keys.groq:
        return GroqLLMService(
            api_key=keys.groq,
            model="llama-3.3-70b-versatile",
        )
    if keys.anthropic:
        return AnthropicLLMService(api_key=keys.anthropic, model="claude-3-5-haiku-latest")
    raise RuntimeError("No LLM provider key available (need Anthropic or Groq).")


def build_tts(transport: str, keys: ProviderKeys, persona: str):
    """Pick TTS. Cartesia for both transports."""
    if not keys.cartesia:
        raise RuntimeError("No TTS provider key available (need Cartesia).")
    voice_id = _persona_voice_id(persona)
    return CartesiaTTSService(
        api_key=keys.cartesia,
        voice_id=voice_id,
        model="sonic-2",
    )


def _persona_voice_id(persona: str) -> str:
    """Map persona slug -> Cartesia voice id. Mirrors features/voice/personas.ts."""
    # Placeholder voice IDs. Replace with real Cartesia voice IDs from
    # play.cartesia.ai/voices once you've picked them.
    return {
        "jarvis": "421b3369-f63f-4b03-8980-37a44df1d4e8",
        "athena": "f9836c6e-a0bd-460e-9d3c-f7299fa60f94",
        "edge": "a0e99841-438c-4a64-b679-ae501e7d6091",
        "watson": "248be419-c632-4f23-adf1-5324ed7dbf1d",
        "hal": "3b554273-4299-48b9-9aaf-eefd438e3941",
        "sage": "421b3369-f63f-4b03-8980-37a44df1d4e8",
    }.get(persona.lower(), "421b3369-f63f-4b03-8980-37a44df1d4e8")


def build_pipeline_task(
    transport_processor: Any,
    ctx: CallContext,
    bridge: "BridgeRegistry",
    tools_schema: list[dict],
) -> PipelineTask:
    """
    Assemble and return the PipelineTask. Caller starts it with `await task.run()`.

    `tools_schema` is the list of tools the user's desktop daemon registered;
    we forward it to the LLM so it knows what's callable.
    """
    stt = build_stt(ctx.transport, ctx.keys)
    llm = build_llm(ctx.transport, ctx.keys)
    tts = build_tts(ctx.transport, ctx.keys, ctx.persona)

    system_prompt = load_persona_prompt(ctx.persona)
    messages = [{"role": "system", "content": system_prompt}]
    context = OpenAILLMContext(messages=messages, tools=tools_schema)
    context_aggregator = llm.create_context_aggregator(context)

    # Wire tool dispatch: when LLM emits tool_use, forward over bridge.
    # NOTE: Pipecat's tool-call wiring varies by version; the canonical 0.0.50+
    # path is via `llm.register_function`. The exact API is documented at
    # https://docs.pipecat.ai/server/services/llm/llm-base . If signature shifts
    # in your installed version, adjust the registration but keep the dispatch.
    async def _dispatch_tool(function_name, tool_call_id, args, llm_obj, context_obj, result_callback):
        log.info("[%s] tool_call %s args=%s", ctx.call_id, function_name, args)
        try:
            result = await bridge.invoke(
                user_id=ctx.user_id,
                call_id=ctx.call_id,
                tool_name=function_name,
                args=args,
                deadline_ms=8000,
                require_confirm=function_name.startswith(("fs.write", "fs.edit", "fs.delete")),
                require_unlock=function_name.startswith("shell."),
                unlock_active=ctx.unlock_phrase_active,
            )
            await result_callback(result)
        except Exception as e:
            log.exception("[%s] tool dispatch failed: %s", ctx.call_id, e)
            await result_callback({"error": str(e)})

    for tool in tools_schema:
        name = tool.get("function", {}).get("name") or tool.get("name")
        if name:
            try:
                llm.register_function(name, _dispatch_tool)
            except AttributeError:
                # Older Pipecat versions; consult docs for the right hook.
                log.warning("LLM service has no register_function; tool dispatch skipped for %s", name)

    pipeline = Pipeline([
        transport_processor.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport_processor.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            audio_in_sample_rate=16000,
            audio_out_sample_rate=24000,
        ),
    )
    return task
