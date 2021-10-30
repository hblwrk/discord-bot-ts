const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('dingsi')
		.setDescription('Replies with Dings!'),
	async execute(interaction) {
		await interaction.reply('Dongs!');
	},
};
