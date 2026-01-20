const http = require('http');
require('dotenv').config();

console.log('🚀 === BOT STARTUP SEQUENCE START ===');
console.log('📦 Checking dependencies...');

const { createClient } = require('@supabase/supabase-js');
console.log('✅ Supabase library loaded.');

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder, ActivityType } = require('discord.js');
console.log('✅ Discord.js library loaded.');

// Dummy server for Koyeb/Health checks
try {
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('Bot is running!');
        res.end();
    }).listen(process.env.PORT || 8000);
    console.log('🌐 Health-check server started on port:', process.env.PORT || 8000);
} catch (e) {
    console.log('⚠️ Could not start health-check server (ignoring):', e.message);
}


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
    ],
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

client.once('clientReady', (c) => {
    console.log(`✅ Logged in as ${c.user.tag}!`);

    // Dynamic Status Logic
    const updatePresence = async () => {
        try {
            // Fetch stats
            const { count: ordersCount, error } = await supabase
                .from('orders')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'verified');

            if (error) throw error;

            const statusOptions = [
                { name: 'NexusStore', type: ActivityType.Watching },
                { name: `${ordersCount || 0} Verified Orders`, type: ActivityType.Watching },
                { name: 'New Products', type: ActivityType.Playing },
                { name: '!help | DM for Support', type: ActivityType.Listening }
            ];

            const option = statusOptions[Math.floor(Math.random() * statusOptions.length)];

            client.user.setPresence({
                activities: [{ name: option.name, type: option.type }],
                status: 'online',
            });

        } catch (err) {
            console.error('Error updating presence:', err.message);
        }
    };

    // Initial update
    updatePresence();

    // Initial sync
    subscribeProductSync();

    // Loop every 30 seconds
    setInterval(updatePresence, 30 * 1000);
});

client.on('messageCreate', async (message) => {
    // Log messages to see if bot receives them (for debugging)
    if (!message.author.bot) {
        console.log(`📩 Received message from ${message.author.tag}: "${message.content}"`);
    }

    if (message.author.bot) return;

    // Filter by channel if configured
    if (process.env.VERIFICATION_CHANNEL_ID && message.channel.id !== process.env.VERIFICATION_CHANNEL_ID) return;

    // Pattern: NXS-XXXX-XXXX
    const codeMatch = message.content.match(/NXS-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
    if (!codeMatch) return;

    const code = codeMatch[0].toUpperCase();

    try {
        // Check Supabase for the code
        const { data: order, error } = await supabase
            .from('orders')
            .select('*')
            .eq('nexus_code', code)
            .single();

        if (error || !order) {
            return message.reply(`❌ Nie znaleziono zamówienia o kodzie **${code}**. Upewnij się, że kod jest poprawny.`);
        }

        if (order.status === 'verified') {
            return message.reply(`⚠️ To zamówienie (**${code}**) zostało już zweryfikowane.`);
        }

        if (order.status === 'rejected') {
            return message.reply(`⚠️ To zamówienie (**${code}**) zostało odrzucone i nie może być ponownie zweryfikowane.`);
        }

        // Check for existing active ticket
        const { data: existingTicket } = await supabase
            .from('tickets')
            .select('channel_id')
            .eq('order_id', order.order_id)
            .eq('status', 'active')
            .single();

        if (existingTicket) {
            return message.reply(`♻️ Zamówienie jest przetwarzane! Sprawdź kanał.`);
        }

        // 1. Create Private Ticket Channel
        const guild = message.guild;
        const channelName = `order-${order.order_id}`;

        // Permissions for the channel
        const permissionOverwrites = [
            {
                id: guild.id,
                deny: [PermissionFlagsBits.ViewChannel],
            },
            {
                id: message.author.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            },
        ];

        if (process.env.ADMIN_ROLE_ID) {
            permissionOverwrites.push({
                id: process.env.ADMIN_ROLE_ID,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            });
        }

        // Create Ticket in Supabase first to get UUID
        const { data: ticketRecord, error: ticketError } = await supabase
            .from('tickets')
            .insert({
                order_id: order.order_id,
                customer_id: message.author.id,
                discord_user_tag: message.author.tag,
                status: 'active'
            })
            .select()
            .single();

        if (ticketError) throw ticketError;

        const ticketChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: process.env.TICKET_CATEGORY_ID || null,
            topic: `${message.author.id}:${ticketRecord.id}`, // Store Customer ID AND Ticket UUID
            permissionOverwrites: permissionOverwrites,
        });

        // Update channel_id in Supabase
        await supabase.from('tickets').update({ channel_id: ticketChannel.id }).eq('id', ticketRecord.id);

        // Link the order and the code to the user's Discord ID for Nexus Cloud statistics
        await supabase.from('orders').update({ discord_user_id: message.author.id }).eq('order_id', order.order_id);
        await supabase.from('redemption_codes').update({ discord_user_id: message.author.id }).eq('order_id', order.order_id);

        // 2. Send Order Info to Ticket
        const items = order.items.map(item => {
            const displayName = (item.title === 'FiveM Bundle' || !item.title) ? item.variantName : `${item.title} (${item.variantName})`;
            return `• ${displayName} x${item.qty}`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle('🎫 Nowe Zgłoszenie Zamówienia')
            .setDescription(`Witaj ${message.author}! Oczekiwanie na weryfikację przez administratora.`)
            .setColor('#3b82f6')
            .addFields(
                { name: 'Kod Nexus', value: `\`${order.nexus_code}\``, inline: true },
                { name: 'ID Zamówienia', value: `\`${order.order_id}\``, inline: true },
                { name: 'Klient', value: `${message.author} (${message.author.tag})`, inline: false },
                { name: 'Email', value: order.email, inline: true },
                { name: 'Kwota', value: `**${order.total} ${order.currency}**`, inline: true },
                { name: 'Produkty', value: items }
            )
            .setTimestamp()
            .setFooter({ text: 'NexusStore Ticketing System' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`claim_${order.id}`)
                    .setLabel('🙋‍♂️ Przejmij (Akceptuj)')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_${order.id}`)
                    .setLabel('⛔ Odrzuć')
                    .setStyle(ButtonStyle.Danger)
            );

        await ticketChannel.send({
            content: `${message.author} | ${process.env.ADMIN_ROLE_ID ? `<@&${process.env.ADMIN_ROLE_ID}>` : '@admin'}`,
            embeds: [embed],
            components: [row]
        });

        // Delete the original message to keep verification channel clean
        await message.delete().catch(() => { });

    } catch (err) {
        console.error(err);
        message.reply('🔥 Wystąpił błąd podczas tworzenia ticketa. Spróbuj ponownie później.');
    }
});

// Sync Messages to Supabase
client.on('messageCreate', async (message) => {
    if (!message.guild || !message.channel.name.startsWith('order-') || !message.channel.topic) return;

    const parts = message.channel.topic.split(':');
    if (parts.length < 2) return;
    const ticketId = parts[1];

    try {
        await supabase.from('ticket_messages').insert({
            ticket_id: ticketId,
            author_name: message.member ? (message.member.displayName) : message.author.username,
            author_tag: message.author.tag,
            content: message.content || (message.embeds.length > 0 ? "[Widżet Embed]" : "[Załącznik]"),
            is_bot: message.author.bot
        });
    } catch (err) {
        console.error('Error syncing message:', err);
    }
});

// Helper to check for Admin Role
function isAdmin(member) {
    if (!process.env.ADMIN_ROLE_ID) return true; // Fail safe if not configured
    return member.roles.cache.has(process.env.ADMIN_ROLE_ID);
}

// Command: !platnosc
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!platnosc')) return;

    if (!isAdmin(message.member)) {
        return message.reply('❌ Ta komenda jest zarezerwowana dla administracji!');
    }

    if (!message.channel.name.startsWith('order-')) {
        return message.reply('❌ Ta komenda działa tylko na kanałach zamówień!');
    }

    try {
        let orderData = null;

        // 1. Try to find the order info from previous messages (extract from embed)
        const messages = await message.channel.messages.fetch({ limit: 20 });
        const botEmbedMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === '🎫 Nowe Zgłoszenie Zamówienia');

        if (botEmbedMsg) {
            const embed = botEmbedMsg.embeds[0];
            const amountField = embed.fields.find(f => f.name === 'Kwota');
            const idField = embed.fields.find(f => f.name === 'ID Zamówienia');

            if (amountField && idField) {
                const amountText = amountField.value.replace(/\*/g, ''); // Remove bold stars
                const [total, currency] = amountText.split(' ');
                const orderId = idField.value.replace(/`/g, ''); // Remove code ticks

                orderData = { total, currency, order_id: orderId };
                console.log('Extracted order data from embed:', orderData);
            }
        }

        // 2. Fallback to Supabase if extraction failed (case-insensitive)
        if (!orderData) {
            const orderIdFromChannel = message.channel.name.replace('order-', '');
            const { data: order, error } = await supabase
                .from('orders')
                .select('*')
                .ilike('order_id', orderIdFromChannel)
                .single();

            if (!error && order) {
                orderData = order;
            }
        }

        if (!orderData) {
            return message.reply('❌ Nie udało się odczytać danych zamówienia. Upewnij się, że wiadomość z danymi zamówienia znajduje się na tym kanale.');
        }

        const link = `https://nexusstore.com/order/${orderData.order_id}`;
        const paymentEmbed = new EmbedBuilder()
            .setTitle('💳 Instrukcja Płatności BLIK')
            .setDescription('Prosimy o dokonanie przelewu na telefon BLIK zgodnie z poniższymi danymi. Po wykonaniu płatności wyślij potwierdzenie na tym kanale.')
            .setColor('#e11d48')
            .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Blik_logo.svg/1200px-Blik_logo.svg.png')
            .addFields(
                { name: '📱 Numer Telefonu (BLIK)', value: '`575 374 776`', inline: false },
                { name: '💰 Kwota do zapłaty', value: `**${orderData.total} ${orderData.currency}**`, inline: true },
                { name: '🆔 Tytuł Przelewu', value: `\`Order ${orderData.order_id}\``, inline: true },
                { name: '⚠️ Ważne', value: 'Upewnij się, że przesyłasz dokładną kwotę. Zamówienie zostanie zrealizowane natychmiast po zaksięgowaniu wpłaty.', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: 'NexusStore Payment System', iconURL: client.user.displayAvatarURL() });

        await message.delete().catch(() => { });
        await message.channel.send({ embeds: [paymentEmbed] });

    } catch (err) {
        console.error(err);
        message.reply('🔥 Błąd podczas pobierania danych płatności.');
    }
});

// Button Interaction Handler (Claim/Reject/Approve)
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, orderId] = interaction.customId.split('_');

    // Restrict administrative button actions to Admins
    if (['claim', 'reject'].includes(action)) {
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: '❌ Tylko administracja może przejmować lub odrzucać zgłoszenia!', ephemeral: true });
        }
    }

    try {
        if (action === 'claim') {
            await interaction.deferUpdate();

            // 1. Update Embed to show who claimed it
            const oldEmbed = interaction.message.embeds[0];
            const newEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#22c55e')
                .addFields({ name: '🔒 Status', value: `Zgłoszenie przyjęte przez: ${interaction.user}` })
                .setFooter({ text: `Zaakceptowano: ${new Date().toLocaleTimeString()}` });

            // 2. Disable Claim button, maybe show Approve/Reject logic if needed?
            // User requested: Pending -> Accepted/Rejected -> Completed/Failed
            // Claim = Accepted.

            // Update DB status to 'accepted' and save admin tag
            await supabase.from('orders')
                .update({
                    status: 'accepted',
                    discord_user: interaction.user.tag
                })
                .eq('id', orderId);

            // Notify channel
            await interaction.channel.send(`✅ Zgłoszenie przyjęte przez ${interaction.user}. \`.`);

            // Disable buttons
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('processed_claim')
                    .setLabel('PRZYJĘTE')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true)
            );

            await interaction.editReply({ embeds: [newEmbed], components: [row] });

        } else if (action === 'reject') {
            await interaction.deferUpdate();

            // Update DB status to 'rejected'
            await supabase.from('orders').update({ status: 'rejected' }).eq('id', orderId);

            const oldEmbed = interaction.message.embeds[0];
            const newEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#ef4444')
                .setDescription(`**Status: ODRZUCONE**\nPrzez: ${interaction.user}`);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('processed_reject')
                    .setLabel('ODRZUCONE')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

            await interaction.editReply({ embeds: [newEmbed], components: [row] });
            await interaction.channel.send(`⛔ Zgłoszenie odrzucone przez ${interaction.user}.`);
        }
    } catch (err) {
        console.error("Interaction error:", err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Błąd.', ephemeral: true });
        }
    }
});

// STATUS COMMANDS (!pomyslnie, !niepomyslnie)
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.toLowerCase();

    if (!content.startsWith('!pomyslnie') && !content.startsWith('!niepomyslnie')) return;

    if (!isAdmin(message.member)) {
        return message.reply('❌ Ta komenda jest zarezerwowana dla administracji!');
    }

    if (!message.channel.name.startsWith('order-') || !message.channel.topic) {
        return message.reply('❌ Ta komenda działa tylko w ticketach zamówień.');
    }

    // Attempt to parse order ID from channel name
    const orderId = message.channel.name.replace('order-', '');

    const isSuccess = content.startsWith('!pomyslnie');
    const newStatus = isSuccess ? 'completed' : 'failed';
    const msgText = isSuccess ? 'POMYŚLNE' : 'NIEPOMYŚLNE';
    const color = isSuccess ? '#22c55e' : '#ef4444';

    try {
        // Update by order_id string/int (ilike match for case-insensitivity because Discord lowers channel names)
        const { data, error, count } = await supabase
            .from('orders')
            .update({
                status: newStatus,
                discord_user: message.author.tag
            })
            .ilike('order_id', orderId)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) {
            return message.reply(`❌ Nie znaleziono zamówienia o ID \`${orderId}\` w bazie danych.`);
        }

        const embed = new EmbedBuilder()
            .setTitle(`Status Zamówienia: ${msgText}`)
            .setDescription(`Administrator ${message.author} zmienił status zamówienia na **${msgText}**.`)
            .setColor(color)
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });

        if (isSuccess) {
            await message.channel.send('✅ Transakcja zakończona sukcesem.');

            // Grant XP Logic
            const order = data[0];
            if (order.discord_user_id && order.total > 0) {
                const xpAmount = Math.floor(order.total * 10);
                const { error: xpError } = await supabase.rpc('add_xp', {
                    user_discord_id: order.discord_user_id,
                    amount: xpAmount,
                    reason: `Zakup zamówienia #${order.order_id}`
                });

                if (xpError) {
                    console.error('Błąd nadawania XP:', xpError);
                } else {
                    await message.channel.send(`⭐ Przyznano **${xpAmount} XP** użytkownikowi za ten zakup!`);
                }
            }
        } else {
            await message.channel.send('⚠️ Transakcja oznaczona jako nieudana.');
        }

    } catch (err) {
        console.error(err);
        message.reply('❌ Błąd bazy danych (czy ID zamówienia w nazwie kanału jest poprawne?).');
    }
});

// Command: !backup
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!backup')) return;

    if (!isAdmin(message.member)) {
        return message.reply('❌ Ta komenda jest zarezerwowana dla administracji!');
    }

    if (!message.channel.name.startsWith('order-')) {
        return message.reply('❌ Ta komenda działa tylko na kanałach zamówień!');
    }

    try {
        if (!message.channel.topic) return message.reply('❌ Nie znaleziono ID klienta w temacie kanału.');

        const parts = message.channel.topic.split(':');
        const customerId = parts[0]; // Only customer ID, not the UUID
        if (!customerId) return message.reply('❌ Nie znaleziono ID klienta w temacie kanału.');

        await message.channel.send('⏳ Generowanie backupu rozmowy...');

        const messages = await message.channel.messages.fetch({ limit: 100 });
        const reversed = messages.reverse();

        let transcript = `TRANSKRYPCJA ZAMÓWIENIA: ${message.channel.name.toUpperCase()}\n`;
        transcript += `Wygenerowano: ${new Date().toLocaleString('pl-PL')}\n`;
        transcript += `====================================================\n\n`;

        reversed.forEach(msg => {
            const time = msg.createdAt.toLocaleString('pl-PL');
            transcript += `[${time}] ${msg.author.tag}: ${msg.content}\n`;
            if (msg.embeds.length > 0) {
                transcript += `[Embed] ${msg.embeds[0].title || 'No Title'}\n`;
            }
        });

        const buffer = Buffer.from(transcript, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: `backup-${message.channel.name}.txt` });

        try {
            const customer = await client.users.fetch(customerId);
            await customer.send({
                content: `📦 **Witaj!** Przesyłamy kopię Twojej rozmowy z kanału **${message.channel.name}**. Dziękujemy za zaufanie!`,
                files: [attachment]
            });
            await message.channel.send('✅ Backup został wysłany do klienta na DM!');
        } catch (dmErr) {
            console.error('Could not send backup to user DM:', dmErr);
            await message.channel.send('❌ Nie udało się wysłać backupu do klienta (zablokowane DM). Wysyłam tutaj:', { files: [attachment] });
        }

    } catch (err) {
        console.error(err);
        message.reply('🔥 Błąd podczas generowania backupu.');
    }
});

// Command: !wezwij
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!wezwij')) return;

    if (!isAdmin(message.member)) {
        return message.reply('❌ Ta komenda jest zarezerwowana dla administracji!');
    }

    if (!message.channel.name.startsWith('order-')) {
        return message.reply('❌ Ta komenda działa tylko na kanałach zamówień!');
    }

    try {
        if (!message.channel.topic) return message.reply('❌ Nie znaleziono ID klienta w temacie kanału.');

        const parts = message.channel.topic.split(':');
        const customerId = parts[0];
        if (!customerId) return message.reply('❌ Nie znaleziono ID klienta w temacie kanału.');

        const adminNick = message.member.displayName || message.author.username;

        try {
            const customer = await client.users.fetch(customerId);
            await customer.send(`🔔 **${adminNick}** użył !wezwij - **Staw się na ticketa!**\n\nAdministrator potrzebuje Twojej uwagi na kanale zamówienia.`);
            await message.channel.send(`✅ Wysłano wezwanie do klienta!`);
        } catch (dmErr) {
            console.error('Could not send DM to user:', dmErr);
            await message.channel.send('❌ Nie udało się wysłać wiadomości do klienta (zablokowane DM).');
        }

    } catch (err) {
        console.error(err);
        message.reply('🔥 Błąd podczas wysyłania wezwania.');
    }
});

// Command: !close
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!close')) return;

    if (!isAdmin(message.member)) {
        return message.reply('❌ Ta komenda jest zarezerwowana dla administracji!');
    }

    if (!message.channel.name.startsWith('order-')) {
        return message.reply('❌ Ta komenda działa tylko na kanałach zamówień!');
    }

    // Mark ticket as closed in Supabase
    if (message.channel.topic) {
        const parts = message.channel.topic.split(':');
        if (parts.length >= 2) {
            const ticketId = parts[1];
            await supabase.from('tickets').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', ticketId);
        }
    }

    await message.channel.send('🔒 Zamykanie ticketa...');
    setTimeout(() => {
        message.channel.delete().catch(() => { });
    }, 2000);
});

// Command: !ogloszenie (Create/Delete)
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!ogloszenie')) return;
    if (!isAdmin(message.member)) return message.reply('❌ Nie masz uprawnień!');

    const args = message.content.split(' ');

    // Command: !ogloszenie usun [id]
    if (args[1] === 'usun') {
        const annId = args[2];
        if (!annId) return message.reply('❌ Podaj ID ogłoszenia do usunięcia. Przykład: `!ogloszenie usun shop-info`');

        try {
            const { data: ann, error } = await supabase
                .from('announcements')
                .select('discord_message_id')
                .eq('id', annId)
                .single();

            if (error || !ann) return message.reply(`❌ Nie znaleziono ogłoszenia o ID \`${annId}\`.`);

            const annChannel = client.channels.cache.get(process.env.ANN_CHANNEL_ID);
            if (annChannel) {
                const msg = await annChannel.messages.fetch(ann.discord_message_id).catch(() => null);
                if (msg) await msg.delete().catch(() => { });
            }

            await supabase.from('announcements').delete().eq('id', annId);
            message.reply(`✅ Ogłoszenie \`${annId}\` zostało usunięte.`);
        } catch (err) {
            console.error(err);
            message.reply('🔥 Błąd podczas usuwania ogłoszenia.');
        }
        return;
    }

    // Command: !ogloszenie [tresc] [id]
    // Regex to match: !ogloszenie (tresc) (id)
    const match = message.content.match(/^!ogloszenie\s+(.+)\s+(\S+)$/s);
    if (!match) return message.reply('❌ Użycie: `!ogloszenie (treść) (id)`. Przykład: `!ogloszenie Zapraszamy do zakupów! promo1`');

    const content = match[1];
    const annId = match[2];

    try {
        const annChannel = client.channels.cache.get(process.env.ANN_CHANNEL_ID);
        if (!annChannel) return message.reply('❌ Kanał ogłoszeń nie jest skonfigurowany (ANN_CHANNEL_ID).');

        const embed = new EmbedBuilder()
            .setTitle('📢 ANNOUNCEMENT')
            .setDescription(content)
            .setColor('#3b82f6')
            .setTimestamp()
            .setFooter({ text: 'NexusStore Announcements', iconURL: client.user.displayAvatarURL() });

        const sentMsg = await annChannel.send({ embeds: [embed] });

        // Save to Supabase
        await supabase.from('announcements').upsert({
            id: annId,
            discord_message_id: sentMsg.id
        });

        message.reply(`✅ Ogłoszenie zostało wysłane i zapisane pod ID: \`${annId}\``);
    } catch (err) {
        console.error(err);
        message.reply('🔥 Błąd podczas wysyłania ogłoszenia.');
    }
});

// Command: !setup (rules/links)
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!setup')) return;
    if (!isAdmin(message.member)) return;

    const type = message.content.split(' ')[1];

    if (type === 'rules') {
        const rulesChannel = client.channels.cache.get(process.env.RULES_CHANNEL_ID);
        if (!rulesChannel) return message.reply('❌ RULES_CHANNEL_ID not set.');

        const embed = new EmbedBuilder()
            .setTitle('📜 NEXUS STORE RULES')
            .setColor('#ffffff')
            .setDescription('By staying on this server, you agree to the following rules:')
            .addFields(
                { name: '1️⃣ Respect', value: 'Be respectful to all members and staff. Hate speech is strictly prohibited.', inline: false },
                { name: '2️⃣ No Spam', value: 'Do not spam messages, emojis, or links.', inline: false },
                { name: '3️⃣ Legit Products', value: 'All transactions should be handled via established channels. No scamming.', inline: false },
                { name: '4️⃣ Support', value: 'Use the ticket system for any purchase issues.', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: 'NexusStore Official Rules' });

        await rulesChannel.send({ embeds: [embed] });
        message.reply('✅ Rules posted!');

    } else if (type === 'links') {
        const linksChannel = client.channels.cache.get(process.env.LINKS_CHANNEL_ID);
        if (!linksChannel) return message.reply('❌ LINKS_CHANNEL_ID not set.');

        const embed = new EmbedBuilder()
            .setTitle('🔗 OFFICIAL LINKS')
            .setDescription('Check out our official store and social media!')
            .setColor('#3b82f6')
            .addFields(
                { name: '🛒 Website', value: '[myweb-psi-three.vercel.app](https://myweb-psi-three.vercel.app)', inline: true }
            )
            .setThumbnail(client.user.displayAvatarURL());

        await linksChannel.send({ embeds: [embed] });
        message.reply('✅ Links posted!');
    }
});

// --- REAL-TIME PRODUCT SYNC ---
const subscribeProductSync = (retries = 3) => {
    console.log('📡 Starting Real-time Product Sync listener...');

    const channel = supabase
        .channel('products-sync')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'products' }, (payload) => {
            console.log('✨ Received Real-time event for new product:', payload.new.title);

            const product = payload.new;
            const shopChannel = client.channels.cache.get(process.env.SHOP_INFO_CHANNEL_ID);

            if (shopChannel) {
                // Get price from first variant as fallback since basePrice is not a column
                const price = (product.variants && product.variants.length > 0 ? product.variants[0].price : 'N/A');

                const embed = new EmbedBuilder()
                    .setTitle('✨ NEW PRODUCT ADDED!')
                    .setDescription(`**${product.title}** is now available in the store!\n\n${product.description || ''}`)
                    .setColor('#facc15')
                    .addFields(
                        { name: '💰 Price', value: `Starting from **${price} PLN**`, inline: true },
                        { name: '🔗 Check it out', value: '[Click here to buy](https://myweb-psi-three.vercel.app)', inline: true }
                    )
                    .setImage(product.image_url || null)
                    .setTimestamp();

                shopChannel.send({ embeds: [embed] }).catch(err => console.error('Error sending product embed:', err));
            } else {
                console.log('⚠️ SHOP_INFO_CHANNEL_ID not found or bot lacks access to it.');
            }
        });

    channel.subscribe((status, err) => {
        console.log('📊 Real-time Sync Status:', status);
        if (err) console.error('❌ Real-time Sync Error:', err.message);

        if (status === 'TIMED_OUT' && retries > 0) {
            console.log(`🔄 Retrying subscription... (${retries} attempts left)`);
            setTimeout(() => subscribeProductSync(retries - 1), 5000);
        }
    });
};



// --- GATEWAY SYSTEM (Entry/Exit) ---

// Welcome Message (Entry)
client.on('guildMemberAdd', async (member) => {
    try {
        const entryChannelId = process.env.ENTRY_CHANNEL_ID;
        if (!entryChannelId) return;

        const entryChannel = member.guild.channels.cache.get(entryChannelId);
        if (!entryChannel) return console.log('⚠️ Entry channel not found. Check ENTRY_CHANNEL_ID in .env');

        const welcomeEmbed = new EmbedBuilder()
            .setTitle('👋 WELCOME TO THE NEXUS!')
            .setDescription(`Hello ${member}! We are glad to have you here.\n\nEnjoy your stay and check out our products!`)
            .setColor('#22c55e')
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: '👤 Username', value: `\`${member.user.tag}\``, inline: true },
                { name: '📊 Member Count', value: `\`${member.guild.memberCount}\``, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'NexusStore Gateway' });

        await entryChannel.send({ embeds: [welcomeEmbed] });
    } catch (err) {
        console.error('Error in guildMemberAdd:', err);
    }
});

// Goodbye Message (Exit)
client.on('guildMemberRemove', async (member) => {
    try {
        const exitChannelId = process.env.EXIT_CHANNEL_ID;
        if (!exitChannelId) return;

        const exitChannel = member.guild.channels.cache.get(exitChannelId);
        if (!exitChannel) return console.log('⚠️ Exit channel not found. Check EXIT_CHANNEL_ID in .env');

        const goodbyeEmbed = new EmbedBuilder()
            .setTitle('👋 THANK YOU FOR VISITING!')
            .setDescription(`Goodbye ${member.user.tag}! We hope to see you again soon.\n\nTake care!`)
            .setColor('#ef4444')
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp()
            .setFooter({ text: 'NexusStore Gateway' });

        await exitChannel.send({ embeds: [goodbyeEmbed] });
    } catch (err) {
        console.error('Error in guildMemberRemove:', err);
    }
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('❌ Bot failed to login:', err.message);
    process.exit(1);
});
