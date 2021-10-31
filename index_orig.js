// Require the necessary discord.js classes
const { Client, Intents } = require('discord.js');
const secrets = require('./modules/secrets');
const token = secrets.read('discord_token')

// Create a new client instance
const client = new Client({ intents: [Intents.FLAGS.GUILDS] });

// When the client is ready, run this code (only once)
client.once('ready', () => {
	console.log('Ready!');
});

client.on('interactionCreate', async interaction => {
	if (!interaction.isCommand()) return;

	const { commandName } = interaction;

	if (commandName === 'ping') {
		await interaction.reply('Pong!');
	} else if (commandName === 'server') {
		await interaction.reply(`Server name: ${interaction.guild.name}\nTotal members: ${interaction.guild.memberCount}`);
	} else if (commandName === 'user') {
		await interaction.reply(`Your tag: ${interaction.user.username}\nYour id: ${interaction.user.tag}\Created: ${interaction.user.createdAt}\n`);
	}
});


// Login to Discord with your client's token
client.login(token);
