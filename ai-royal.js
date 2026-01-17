'use strict';

/**
 * Minimal Discord mention-bot using OpenAI-compatible Chat Completions.
 * Responds only when mentioned; no conversation memory or persistence.
 */

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Partials,
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.NOVITA_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || process.env.NOVITA_BASE_URL || 'https://api.openai.com/v1')
  .replace(/\/+$/, '');
const OPENAI_API_URL = process.env.OPENAI_API_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || process.env.NOVITA_MODEL || 'gpt-4o-mini';
const OPENAI_AUTH_HEADER = process.env.OPENAI_AUTH_HEADER || 'Authorization';
const OPENAI_AUTH_PREFIX = process.env.OPENAI_AUTH_PREFIX ?? 'Bearer';
const OPENAI_EXTRA_HEADERS = process.env.OPENAI_EXTRA_HEADERS || '';
const SYSTEM_PROMPT = 'You are a helpful Discord assistant. Be concise and accurate.';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90_000);
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 30);
const MAX_HISTORY_CHARS = Number(process.env.MAX_HISTORY_CHARS || 12000);
const AUTO_BAN_CHANNEL_IDS = (process.env.AUTO_BAN_CHANNEL_IDS || '1458316803217424427')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);
const AUTO_BAN_CHANNEL_SET = new Set(AUTO_BAN_CHANNEL_IDS);
const AUTO_BAN_DELETE_MESSAGE_SECONDS = Math.min(604800, Math.max(0, Number(process.env.AUTO_BAN_DELETE_MESSAGE_SECONDS || 86400)));

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !OPENAI_API_KEY) {
  console.error('Missing required env vars. Need: DISCORD_TOKEN, DISCORD_CLIENT_ID, OPENAI_API_KEY');
  process.exit(1);
}

const state = {
  globalSystemPrompt: SYSTEM_PROMPT,
  conversations: {}, // userId -> { messages: [] }
};

function getSystemPrompt() {
  const p = (state.globalSystemPrompt || '').trim();
  return p.length ? p : SYSTEM_PROMPT;
}

function getConversation(userId) {
  if (!state.conversations[userId]) {
    state.conversations[userId] = { messages: [] };
  }
  return state.conversations[userId];
}

function approxChars(messages) {
  let n = 0;
  for (const m of messages) n += (m.content || '').length;
  return n;
}

function trimHistory(conversation) {
  while (conversation.messages.length > MAX_HISTORY_MESSAGES) conversation.messages.shift();
  while (approxChars(conversation.messages) > MAX_HISTORY_CHARS && conversation.messages.length > 1) {
    conversation.messages.shift();
  }
}

/**
 * Remove anything inside <think>...</think> (including the tags) from model output.
 * Handles multiline and malformed leftovers.
 */
function stripThinkBlocks(text) {
  if (!text) return text;

  let out = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<\/?think\b[^>]*>/gi, '');
  // Also scrub common variants some models emit
  out = out.replace(/<\s*reasoning\b[^>]*>[\s\S]*?<\/\s*reasoning\s*>/gi, '');
  out = out.replace(/<\/?\s*reasoning\b[^>]*>/gi, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}

function buildChatCompletionsUrl() {
  if (OPENAI_API_URL) return String(OPENAI_API_URL).trim();
  const clean = OPENAI_BASE_URL.replace(/\/+$/, '');
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

function parseExtraHeaders(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OPENAI_EXTRA_HEADERS must be a JSON object');
    }
    return parsed;
  } catch (err) {
    console.error(`[config] Invalid OPENAI_EXTRA_HEADERS JSON: ${err.message}`);
    process.exit(1);
  }
}

const OPENAI_HEADERS = (() => {
  const extra = parseExtraHeaders(OPENAI_EXTRA_HEADERS);
  const authValue = OPENAI_AUTH_PREFIX
    ? `${OPENAI_AUTH_PREFIX} ${OPENAI_API_KEY}`.trim()
    : OPENAI_API_KEY;
  return {
    ...extra,
    'Content-Type': 'application/json',
    [OPENAI_AUTH_HEADER]: authValue,
  };
})();

async function openAiChatCompletions({ conversation, systemPrompt, logHint }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversation.messages,
  ];

  const url = buildChatCompletionsUrl();
  const payload = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 512,
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: OPENAI_HEADERS,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      let errMsg = text;
      try {
        const j = JSON.parse(text);
        errMsg = j?.error?.message || j?.message || text;
      } catch (_) {}
      throw new Error(`OpenAI-compatible API error (${res.status}): ${errMsg}`);
    }

    const data = JSON.parse(text);
    const msg = data?.choices?.[0]?.message || {};
    const rawContent = msg.content ?? data?.choices?.[0]?.text ?? '';
    const cleanedContent = stripThinkBlocks(rawContent);
    // Some reasoning models also return `reasoning_content`; prefer it only if main content is empty.
    const cleanedReasoning = stripThinkBlocks(msg.reasoning_content || '');
    const content = cleanedContent || cleanedReasoning;

    console.log(`[chat] ${logHint} responded`);
    return (content || '').trim();
  } finally {
    clearTimeout(t);
  }
}

function buildCommands() {
  const reset = new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset all conversation memory for every user.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  const systemprompt = new SlashCommandBuilder()
    .setName('systemprompt')
    .setDescription('Set a custom global system prompt for the bot.')
    .addStringOption(opt =>
      opt
        .setName('prompt')
        .setDescription('The system prompt to use')
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt
        .setName('reset_context')
        .setDescription('Also clear all conversations so the new prompt takes effect immediately')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  return [reset, systemprompt].map(c => c.toJSON());
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const body = buildCommands();

  if (DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body });
    console.log(`[slash] Registered guild commands for guild=${DISCORD_GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
    console.log('[slash] Registered global commands (may take a bit to appear everywhere)');
  }
}

async function sendLongReply(message, text) {
  const MAX = 1900; // safe under 2000 with formatting
  if (!text) text = '(no content)';

  const parts = [];
  let buf = '';

  const pushBuf = () => {
    if (buf.trim().length) parts.push(buf);
    buf = '';
  };

  for (const line of String(text).split('\n')) {
    if ((buf ? `${buf}\n${line}` : line).length > MAX) {
      pushBuf();

      if (line.length > MAX) {
        for (let i = 0; i < line.length; i += MAX) {
          parts.push(line.slice(i, i + MAX));
        }
      } else {
        buf = line;
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  pushBuf();

  await message.reply({ content: parts[0], allowedMentions: { repliedUser: false } });
  for (let i = 1; i < parts.length; i++) {
    await message.channel.send({ content: parts[i] });
  }
}

function stripBotMention(content, botUserId) {
  const re = new RegExp(`<@!?${botUserId}>`, 'g');
  return String(content || '').replace(re, '').trim();
}

async function autoBanIfRestrictedChannel(message) {
  if (!AUTO_BAN_CHANNEL_SET.size) return false;
  if (!message.guild) return false;
  if (!AUTO_BAN_CHANNEL_SET.has(message.channelId)) return false;
  if (!message.channel?.isTextBased?.()) return false;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return false;

  const reason = `Auto-ban: posted in restricted channel ${message.channel?.name ? `#${message.channel.name}` : message.channelId}`;

  try {
    if (message.deletable) {
      await message.delete().catch(() => {});
    }

    const recentMessages = await message.channel.messages?.fetch({ limit: 100 }).catch(() => null);
    if (recentMessages) {
      const userMessages = recentMessages.filter(m => m.author?.id === message.author.id);
      if (userMessages.size) {
        await message.channel.bulkDelete(userMessages, true).catch(() => {});
      }
    }

    await message.guild.members.ban(member, {
      deleteMessageSeconds: AUTO_BAN_DELETE_MESSAGE_SECONDS,
      reason,
    });

    console.log(`[auto-ban] Banned ${member.user.tag} (${member.id}) for posting in ${message.channelId}`);
    return true;
  } catch (err) {
    console.error('[auto-ban error]', err);
    return false;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  if (!client.user) return;
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands().catch(err => console.error('[slash] register failed', err));
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'reset') {
      state.conversations = {};
      await interaction.reply({ content: '✅ Cleared all conversation memory.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'systemprompt') {
      const prompt = interaction.options.getString('prompt', true);
      const resetContext = interaction.options.getBoolean('reset_context') || false;
      state.globalSystemPrompt = prompt.trim();
      if (!state.globalSystemPrompt.length) {
        state.globalSystemPrompt = SYSTEM_PROMPT;
      }
      if (resetContext) state.conversations = {};
      await interaction.reply({ content: '✅ Updated global system prompt.', ephemeral: true });
      return;
    }

  } catch (err) {
    console.error('[interaction error]', err);
    if (!interaction.replied) {
      await interaction.reply({ content: `❌ Error: ${err?.message || String(err)}`, ephemeral: true });
    }
  }
});

client.on('messageCreate', async (message) => {
  if (!client.user) return;
  if (message.author.bot) return;

  const autoBanned = await autoBanIfRestrictedChannel(message);
  if (autoBanned) return;

  if (!message.guild) return; // ignore DMs for the chat assistant

  const mentioned = message.mentions.users.has(client.user.id);
  if (!mentioned) return;

  const cleaned = stripBotMention(message.content || '', client.user.id);
  const userMessage = cleaned.trim().length
    ? cleaned.trim()
    : 'Respond helpfully to the user.';

  const conversation = getConversation(message.author.id);
  conversation.messages.push({ role: 'user', content: userMessage });
  trimHistory(conversation);

  try {
    await message.channel.sendTyping();

    const assistantText = await openAiChatCompletions({
      conversation,
      systemPrompt: getSystemPrompt(),
      logHint: `${message.guildId}/${message.channelId}`,
    });

    conversation.messages.push({ role: 'assistant', content: assistantText });
    trimHistory(conversation);

    await sendLongReply(message, assistantText);
  } catch (err) {
    console.error('[message error]', err);
    try {
      await message.reply({
        content: `❌ Error: ${err?.message || String(err)}`,
        allowedMentions: { repliedUser: false },
      });
    } catch (_) {}
  }
});

client.login(DISCORD_TOKEN);
