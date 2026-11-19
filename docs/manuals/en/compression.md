# Context compression

For Sufficit AI and OpenAI-compatible sessions, Symposium can limit the
history sent to the model or replace older live context with a summary.
The original transcript remains available. CLI backends manage their
own context.

1. Open **Symposium: Configuration** and select **Context and history**.
2. Set **Max history messages** to limit the request window. A value of
   `0` removes this local message limit. The provider still applies its
   context limit.
3. To summarize older turns automatically, choose **Automatic compaction**
   between 60% and 90% of the model's context window. The default is
   disabled. Run `/compact` in an OpenAI-compatible chat to request a
   summary manually.

The summary keeps a recent tail of messages. The default tail is six
messages and may expand to preserve tool calls with their results. If a
detail is missing, ask the agent to retrieve the relevant passage with
`read_session`.

The settings panel also lists request compression presets. A preset applies
when the session supplies it to the OpenAI-compatible adapter. The preset
label **Token Budget** refers to an estimate. Use `/compact` when you want
the backend to generate a summary.

See [tool history diagnostics](openai-history.md) or the
[Portuguese manual](../pt-br/compression.md).
