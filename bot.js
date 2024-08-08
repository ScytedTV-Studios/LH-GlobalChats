const { Client, Intents, MessageAttachment, MessageEmbed } = require('discord.js');
const fs = require('fs');
const csv = require('csv-parser');
require('dotenv').config();

const token = process.env.BOT_TOKEN;

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES
    ]
});

let channels = [];
let messageQueue = [];

// Function to load channels from the CSV file
function loadChannels() {
    channels = [];
    fs.createReadStream('channels.csv')
        .pipe(csv())
        .on('data', (row) => {
            channels.push({
                serverId: row.serverId,
                channelId: row.channelId
            });
        })
        .on('end', () => {
            console.log('CSV file successfully processed:', channels);
        });
}

// Function to save channels to the CSV file
function saveChannels() {
    const writer = fs.createWriteStream('channels.csv');
    writer.write('serverId,channelId\n');
    channels.forEach(channel => {
        writer.write(`${channel.serverId},${channel.channelId}\n`);
    });
    writer.end();
}

// Function to send joining message to all connected channels
async function sendJoiningMessage(serverName) {
    for (const channelInfo of channels) {
        try {
            const server = await client.guilds.fetch(channelInfo.serverId);
            if (!server) {
                console.log(`Server not found: ${channelInfo.serverId}`);
                continue;
            }

            const channel = await server.channels.fetch(channelInfo.channelId);
            if (!channel || channel.type !== 'GUILD_TEXT') {
                console.log(`Channel not found or not accessible: ${channelInfo.channelId}`);
                continue;
            }

            await channel.send(`**${serverName}** has joined the global chat!`);
            console.log(`Joining message sent to channel ${channelInfo.channelId} in server ${channelInfo.serverId}`);
        } catch (error) {
            console.error(`Could not send joining message to channel ${channelInfo.channelId}:`, error);
        }
    }
}

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    loadChannels();
    processQueue();
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!live broadcast ') && message.author.id === '852572302590607361') {
        message.delete();
        const broadcastMessage = message.content.match(/!live broadcast "(.*)"/);
        if (broadcastMessage) {
            const textToSend = broadcastMessage[1];
            const embed = new MessageEmbed()
                .setTitle("📢 Broadcast 📢")
                .setDescription(textToSend)
                .setColor("#FEEA3B");

            for (const channelInfo of channels) {
                messageQueue.push({
                    channelInfo,
                    embed
                });
            }
        }
        return;
    }

    if (message.content.startsWith('!live')) {
        if (!message.member.permissions.has('MANAGE_GUILD')) {
            return message.reply('You do not have permission to use this command.');
        }

        const existingGlobalChat = channels.find(c => c.serverId === message.guild.id);
        if (existingGlobalChat) {
            return message.reply('This server already has a global chat channel.');
        }

        channels.push({
            serverId: message.guild.id,
            channelId: message.channel.id
        });
        saveChannels();
        sendJoiningMessage(message.guild.name);
        return message.reply('Global chat channel set successfully.');
    }

    if (message.content.startsWith('!') || message.content.startsWith('?')) return;

    const senderChannelId = message.channel.id;
    console.log(`Message received in channel ${senderChannelId} from ${message.author.username}: ${message.content}`);

    const isGlobalChannel = channels.some(channel => channel.channelId === senderChannelId);
    if (!isGlobalChannel) return;

    let messageContent = message.content.replace(/@(here|everyone)/g, '@\u200b$1');
    messageContent = messageContent.replace(/<@!?(\d+)>/g, (match, userId) => {
        const user = message.guild.members.cache.get(userId);
        if (user) {
            return `\`@${user.displayName}\``;
        } else {
            return match;
        }
    });
    messageContent = messageContent || '_ _';
    const attachments = message.attachments.map(attachment => new MessageAttachment(attachment.url));

    if (message.reference) {
        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            let quote = referencedMessage.content;
            if (quote.startsWith('>')) {
                const newlineIndex = quote.indexOf('\n');
                if (newlineIndex !== -1) {
                    quote = quote.slice(newlineIndex + 1).trim();
                } else {
                    quote = '';
                }
            }
            if (quote) {
                messageContent = `> ${quote}\n${messageContent}`;
            }
        } catch (error) {
            console.error(`Could not fetch referenced message:`, error);
        }
    }

    const targetChannels = channels.filter(c => c.channelId !== senderChannelId);
    for (const channelInfo of targetChannels) {
        messageQueue.push({
            channelInfo,
            message: {
                content: messageContent,
                username: message.author.username,
                avatar: message.author.displayAvatarURL({ format: 'png', dynamic: true }),
                attachments
            }
        });
    }
});

async function processQueue() {
    while (true) {
        if (messageQueue.length > 0) {
            const { channelInfo, message, embed } = messageQueue.shift();

            try {
                const server = await client.guilds.fetch(channelInfo.serverId);
                if (!server) {
                    console.log(`Server not found: ${channelInfo.serverId}`);
                    continue;
                }

                const channel = await server.channels.fetch(channelInfo.channelId);
                if (!channel || channel.type !== 'GUILD_TEXT') {
                    console.log(`Channel not found or not accessible: ${channelInfo.channelId}`);
                    continue;
                }

                let webhooks = await channel.fetchWebhooks();
                let webhook;

                if (message) {
                    webhook = webhooks.find(w => w.name === message.username);
                    if (!webhook) {
                        if (webhooks.size < 15) {
                            webhook = await channel.createWebhook(message.username, {
                                avatar: message.avatar
                            });
                        } else {
                            const webhooksArray = Array.from(webhooks.values());
                            webhook = webhooksArray[Math.floor(Math.random() * webhooksArray.length)];
                            await webhook.edit({
                                name: message.username,
                                avatar: message.avatar
                            });
                        }
                    }

                    await webhook.send({
                        content: message.content,
                        files: message.attachments
                    });

                    console.log(`Message sent to channel ${channelInfo.channelId} in server ${channelInfo.serverId} via webhook`);
                } else if (embed) {
                    if (webhooks.size < 15) {
                        webhook = await channel.createWebhook(client.user.username, {
                            avatar: client.user.displayAvatarURL({ format: 'png', dynamic: true })
                        });
                    } else {
                        const webhooksArray = Array.from(webhooks.values());
                        webhook = webhooksArray[Math.floor(Math.random() * webhooksArray.length)];
                    }

                    await webhook.send({
                        embeds: [embed],
                        username: client.user.username,
                        avatarURL: client.user.displayAvatarURL({ format: 'png', dynamic: true })
                    });

                    console.log(`Broadcast message sent to channel ${channelInfo.channelId} in server ${channelInfo.serverId} via webhook`);
                }
            } catch (error) {
                console.error(`Could not send message to channel ${channelInfo.channelId}:`, error);
            }
        } else {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Manually crash the bot if it won't stop on its own
client.on('messageCreate', async message => {
    const USER_IDS = ['852572302590607361', '1147308835808235581'];
    
    if (USER_IDS.includes(message.author.id) && message.content === '!crash') {

        console.log('Crash command received. The bot will crash now.');

        throw new Error('Intentional crash for testing purposes!');
    }
});


client.login(token);