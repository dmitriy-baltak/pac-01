# Best Practices for Small/Local LLMs as Tool-Calling Agents

Research compiled 2026-04-07. Covers Qwen 14B, Llama 8B-70B, and similar models.

---

## 1. Prompt Structure for Tool Calling

### Hermes-Style Template (Recommended for Qwen3)

Qwen3's chat template has built-in support for Hermes-style tool calling. The format:

```
<|im_start|>system
You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags.

<tools>
[
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "City name"}
        },
        "required": ["city"]
      }
    }
  }
]
</tools>

For each function call, return a JSON object within <tool_call></tool_call> tags.
<|im_end|>
```

Tool calls are returned as:
```
<tool_call>
{"name": "get_weather", "arguments": {"city": "Munich"}}
</tool_call>
```

Tool results are returned as:
```
<tool_response>
{"name": "get_weather", "content": {"temp": 15, "condition": "cloudy"}}
</tool_response>
```

### Key Prompt Structure Principles

1. **Specificity over brevity**: Instead of "Search the web," use "Search for current information when users ask about recent events, news, or data."
2. **Early anchoring**: Put key criteria and argument requirements at the beginning of tool descriptions.
3. **Use delimiters**: XML-like tags (`<tools>`, `<tool_call>`, `<tool_response>`) create clear boundaries.
4. **Repeat critical instructions**: Put the most important instruction at the end of the system prompt as well.
5. **Use CAPS for critical rules**: "ULTRA IMPORTANT" and similar emphasis helps prevent instruction abandonment.
6. **Simple language > complex language**: Even for agents, clarity beats sophistication.

---

## 2. System Prompt Design for Small Models

### Recommended Structure

```
1. Role assignment (1-2 sentences)
2. Available tools (JSON schema in <tools> tags)
3. Output format specification
4. Step-by-step procedure / workflow rules
5. Constraints and safety rules
6. Verification checklist
7. Repeat most critical instruction
```

### Length Considerations

- **Cline-style**: ~11,000 characters with clear XML sections (works for capable models)
- **For small models**: Shorter, more focused prompts often work better. Keep tool descriptions concise to minimize token usage while maintaining clarity.
- **Rule of thumb**: Include only what the model needs for the current task. Avoid kitchen-sink system prompts.

### What Works for Small Models Specifically

- **Structured markers**: Use explicit markers like THOUGHTS/PLAN/TOOL_CALL/TOOL_RESULT/STATUS
- **Mode differentiation**: Separate planning phase from execution phase
- **Checklist approach**: "Before finalizing, verify: 1) correct tool selected, 2) all required params present, 3) output format matches spec"
- **Draft-review-finalize pattern**: Separate generating from reviewing within a single prompt

---

## 3. ReAct vs. Function Calling

### ReAct (Reason-Act)
- **How it works**: LLM outputs reasoning and actions in text (Thought -> Action -> Observation loop)
- **Advantage for small models**: Works with ANY LLM regardless of native function calling support
- **Disadvantage**: Slower (verbose reasoning), requires careful prompt engineering and text parsing

### Native Function Calling
- **How it works**: LLM outputs structured function call objects (JSON)
- **Advantage**: More reliable formatting, cleaner integration, less parsing overhead
- **Disadvantage**: Requires models fine-tuned for function calling

### Recommendation for Qwen3 14B

**Use native function calling (Hermes-style), NOT ReAct.**

Reasons:
- Qwen3 is specifically fine-tuned for tool calling and has native support
- The Qwen team explicitly recommends AGAINST ReAct/stopword-based templates for Qwen3 reasoning models, because "the model may output stopwords in the thought section, potentially leading to unexpected behavior"
- Qwen3 14B achieves 0.971 F1 score on tool calling benchmarks
- Use Hermes-style `<tool_call>` tags for clean parsing

### When ReAct Still Makes Sense
- Models without native function calling training
- Complex multi-step reasoning tasks where visible thought process aids debugging
- Prototyping before committing to a specific model

---

## 4. JSON Schema Compliance with Weaker Models

### Approaches (from least to most reliable)

1. **Prompt-only** ("Return JSON matching this schema"): ~35% compliance with small models
2. **Prompt + examples**: Better but still unreliable for complex schemas
3. **Constrained decoding / grammar-guided generation**: 100% structural compliance

### Constrained Decoding (Recommended)

- Works by masking invalid tokens during generation at the token level
- Ollama supports this via the `format` parameter with JSON schema
- Tools: Outlines, SGLang, Guidance, XGrammar, llama.cpp grammars
- **Critical caveat**: Constraining to strict JSON during reasoning tasks drops performance 10-15% vs free-form generation. Consider a hybrid approach: let the model reason freely, then constrain only the final output.

### Practical Implementation with Ollama

```python
# Use Pydantic to define schema
from pydantic import BaseModel

class ToolCall(BaseModel):
    name: str
    arguments: dict

# Pass schema via format parameter
response = ollama.chat(
    model='qwen3:14b',
    messages=messages,
    format=ToolCall.model_json_schema()
)
```

### Tips for Better JSON Compliance
- Add "return as JSON" explicitly in the prompt
- Set temperature to 0 for deterministic output (but see Qwen3 caveat below)
- Use Pydantic (Python) or Zod (JS) for schema definition and validation
- For complex schemas, break into smaller, simpler sub-schemas

---

## 5. Preventing Small Models from Ignoring Instructions

### Proven Techniques

1. **Explicit constraints with XML delimiters**: Separate instructions from data clearly
2. **Capitalization for critical rules**: Use ALL CAPS sparingly but effectively
3. **Repeat key instructions**: Put critical rules both at the start and end of system prompt
4. **One tool per turn**: Don't ask the model to do multiple things at once
5. **Confirmation gates**: Require the model to confirm understanding before acting
6. **Environment context**: Tell the model exactly what it can and cannot do
7. **Examples of correct behavior**: Show, don't just tell
8. **Verification steps**: "Before responding, check: did you follow rules 1-5?"

### Structural Approaches
- **Modular tool organization**: Clear sections with XML tags
- **Separated concerns**: Don't mix tool definitions with behavioral rules
- **Iterative confirmation loops**: Use one tool, wait for feedback, then proceed
- **Short context windows**: Small models degrade when conversation history exceeds ~20K tokens. Implement sliding windows that drop older tool results.

---

## 6. Few-Shot Examples vs. Rules-Based Instructions

### Key Finding (2024-2025)

**For reasoning models (including Qwen3 with thinking mode): zero-shot often outperforms few-shot.**

Research from "From Medprompt to o1" showed that 5-shot prompting actually REDUCED performance compared to zero-shot with reasoning models. DeepSeek R1 reached the same conclusion, recommending zero-shot for optimal results.

### When to Use Each

| Approach | Best For | Avoid When |
|----------|----------|------------|
| **Zero-shot** | Reasoning models, simple tasks, thinking-mode models | Model has no training on the task format |
| **Few-shot** | Non-reasoning models, novel output formats, teaching specific patterns | Using reasoning models, very long contexts |
| **Dynamic few-shot** | Large tool libraries, diverse task types | Simple single-tool scenarios |
| **Rules-based** | Consistent behavior across varied inputs, safety constraints | Novel creative tasks |

### Dynamic Few-Shot (Advanced)

For agents with many tools, use semantic similarity to select the most relevant examples:
1. Embed all example inputs using a small embedding model (e.g., all-MiniLM-L6-v2)
2. At runtime, embed the user query and retrieve top-K most similar examples
3. Include only those 2-3 examples in the prompt
4. Reduces token usage while improving relevance

---

## 7. Thinking Mode and Scratchpads

### Qwen3 Thinking Mode Configuration

**Thinking mode ON** (default): Generates reasoning in `<think>...</think>` blocks before responding.
- Temperature: 0.6, TopP: 0.95, TopK: 20, MinP: 0
- DO NOT use greedy decoding (causes performance degradation and endless repetitions)
- Best for: complex reasoning, multi-step planning, debugging

**Thinking mode OFF**: Direct responses without reasoning.
- Temperature: 0.7, TopP: 0.8, TopK: 20, MinP: 0
- Best for: simple tool calls, fast responses, straightforward tasks

**Dynamic switching**: Use `/think` or `/no_think` tags in user messages.

### When to Enable Thinking in Agent Loops

- **Enable for**: Initial planning, complex tool selection decisions, error recovery
- **Disable for**: Straightforward tool execution chains (read file, parse, call API, repeat)
- In multi-turn conversations, historical model output should contain ONLY the final output, NOT thinking content (saves tokens, prevents confusion)

### Chain-of-Thought for Small Models

- Symbolic Chain-of-Thought Distillation (SCoTD): Train small models on rationalizations from larger teacher models
- Dynamic Recursive CoT (DR-CoT): Framework for parameter-efficient models with recursive reasoning and voting
- Key insight: Even 125M-1.3B parameter models benefit from CoT through distillation

### Scratchpad Pattern

```
Before calling any tool, write your analysis:
THOUGHTS: [What do I know? What do I need?]
PLAN: [Which tool to call and why]
TOOL_CALL: [The actual tool invocation]
```

This structured scratchpad helps small models maintain coherence across multi-step tasks.

---

## 8. Prompt Injection Defense with Small Models

### The Challenge

Small models are MORE vulnerable to prompt injection because they have weaker instruction-following capabilities and less robust safety training.

### Practical Defenses

1. **System-level isolation (CaMeL approach)**: Create a protective layer around the LLM that separates control flow from data flow, so untrusted data can never impact program flow
2. **Multi-agent pipeline**: Use specialized agents for detection and neutralization (achieved 0% attack success in testing)
3. **Fine-tuned detection models**: Small models (like ProtectAI) can be fine-tuned specifically to detect prompt injection attempts
4. **Input sanitization**: Strip or escape special tokens/delimiters before passing user content to the model
5. **Output validation**: Always validate model outputs against expected schemas before executing any actions

### Important Warning

Research examining 12 published defenses found that "adaptive attacks" bypass most defenses with >90% success. Defense-in-depth (multiple layers) is essential. Do not rely on prompt-only defenses for small models.

---

## 9. Qwen-Specific Guidance

### Model Selection

| Model | Tool Call F1 | Speed | Recommendation |
|-------|-------------|-------|----------------|
| Qwen3-14B | 0.971 | ~142s/interaction | Best accuracy, higher latency |
| Qwen3-8B | Strong | Faster | Good balance for most tasks |
| Qwen3-32B | ~87% first-attempt | Slower | Occasional format drift past 20K tokens |

### Qwen3 Best Practices

1. **Use Qwen-Agent framework** when possible -- it encapsulates tool-calling templates and parsers
2. **Use Hermes-style tool calling** (NOT ReAct) for Qwen3
3. **Enable `think` parameter** in Ollama for improved reasoning: `"think": true`
4. **Context management**: Keep context under 128K tokens; implement sliding window for older tool results
5. **Format adherence**: Add explicit formatting instructions in system prompt, especially for conversations exceeding 20K tokens
6. **Sampling parameters**:
   - Thinking mode: T=0.6, TopP=0.95, TopK=20
   - Non-thinking: T=0.7, TopP=0.8, TopK=20
   - NEVER use greedy decoding (T=0)
7. **Multi-turn history**: Strip thinking content from historical messages; only keep final outputs
8. **Agent RL benchmark**: Qwen3-14B achieves 65.1 on Tau2-Bench for agentic tasks

### Ollama-Specific Setup

```bash
# Run with tool support
ollama run qwen3:14b

# In API calls, pass tools array and enable thinking
curl http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b",
  "messages": [...],
  "tools": [...],
  "think": true,
  "stream": false
}'
```

---

## 10. Fine-Tuning Small Models for Tool Calling (If Needed)

### Quick Results with LoRA

- Training a 1B model on tool calling: 10% -> 79% syntactic accuracy in 15 minutes on a MacBook
- Dataset: Salesforce/xlam-function-calling-60k (800 samples sufficient for basic capability)
- Key finding: "Format learning is easier than reasoning learning" -- 79% valid JSON but only 56% semantically correct function calls
- Use 4-bit quantization (QLoRA) to fit on consumer hardware

### Specialized Fine-Tuning Results

- Fine-tuned 350M parameter model achieved 77.55% pass rate on ToolBench (vs ChatGPT-CoT at 26%)
- Key insight: Efficiency through specialization, not scale

### When to Fine-Tune vs. Prompt Engineer

- **Prompt engineer first**: If Qwen3-14B with good prompts gets you >80% accuracy, don't fine-tune
- **Fine-tune when**: You need a specific output format not covered by the base model, or you're using a very small model (<4B params)
- **Dataset format matters as much as content**: Convert training data to match the model's exact chat template

---

## Summary: Top 10 Actionable Recommendations

1. **Use Hermes-style `<tool_call>` format** with Qwen3 (not ReAct)
2. **Enable thinking mode selectively** -- for planning and complex decisions, disable for simple tool chains
3. **Use constrained decoding** (Ollama `format` parameter) for guaranteed JSON compliance
4. **Keep system prompts structured** with XML tags, explicit sections, and repeated critical rules
5. **Zero-shot > few-shot** for Qwen3 with thinking mode enabled
6. **One tool per turn** with confirmation loops for reliability
7. **Manage context aggressively** -- sliding window, strip thinking blocks from history, stay under 20K tokens
8. **Use explicit verification steps** ("Before responding, verify: correct tool, all params, valid format")
9. **Never use greedy decoding** with Qwen3 (T=0.6 for thinking, T=0.7 for non-thinking)
10. **Layer defenses** for prompt injection -- don't rely on prompt-only protection

---

## Sources

### Research Papers
- [Small Language Models for Efficient Agentic Tool Calling](https://arxiv.org/abs/2512.15943)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [Symbolic Chain-of-Thought Distillation](https://arxiv.org/abs/2306.14050)
- [Small Language Models are the Future of Agentic AI](https://arxiv.org/pdf/2506.02153)
- [Generating Structured Outputs from Language Models: Benchmark and Studies](https://arxiv.org/html/2501.10868v1)
- [PromptArmor: Simple yet Effective Prompt Injection Defenses](https://arxiv.org/html/2507.15219v1)
- [Dynamic Recursive Chain-of-Thought (DR-CoT)](https://www.nature.com/articles/s41598-025-18622-6)
- [Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813)

### Official Documentation
- [Qwen3-8B Model Card](https://huggingface.co/Qwen/Qwen3-8B)
- [Qwen Function Calling Docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html)
- [Ollama Tool Calling](https://docs.ollama.com/capabilities/tool-calling)
- [Ollama Structured Outputs](https://ollama.com/blog/structured-outputs)
- [Hermes Function Calling](https://github.com/NousResearch/Hermes-Function-Calling)

### Practical Guides
- [Function Calling in AI Agents (Prompting Guide)](https://www.promptingguide.ai/agents/function-calling)
- [Constrained Decoding Guide](https://www.aidancooper.co.uk/constrained-decoding/)
- [Build ReAct Agents with SLMs from Scratch](https://www.akshaymakes.com/blogs/build-react-agents-slms-scratch)
- [Fine-Tuning SLMs on Agentic Tool Calling](https://medium.com/@dataenthusiast.io/fine-tuning-slms-on-agentic-tool-calling-an-experiment-ccbef62ac5c7)
- [Dynamic Few-Shot Prompting for AI Agents](https://medium.com/@stefansipinkoski/optimizing-ai-agents-with-dynamic-few-shot-prompting-585919f694cc)
- [Prompt Engineering for AI Agents (PromptHub)](https://www.prompthub.us/blog/prompt-engineering-for-ai-agents)
- [Qwen3 Agent Tool Integration Best Practices](https://qwen3lm.com/qwen3-agent-tool-integration-best-practices/)
- [Docker: Local LLM Tool Calling Evaluation](https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/)
- [Best Ollama Models for Function Calling 2025](https://collabnix.com/best-ollama-models-for-function-calling-tools-complete-guide-2025/)
- [Structured Output Generation in LLMs](https://medium.com/@emrekaratas-ai/structured-output-generation-in-llms-json-schema-and-grammar-based-decoding-6a5c58b698a6)
- [Tool-Calling Agent vs. ReAct Agent](https://medium.com/@dzianisv/vibe-engineering-langchains-tool-calling-agent-vs-react-agent-and-modern-llm-agent-architectures-bdd480347692)
