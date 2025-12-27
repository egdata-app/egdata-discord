import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
} from 'discord.js';
import type { SingleOffer } from '../types/offers.js';
import { client } from '../utils/client.js';
import { offersDictionary } from '../utils/offer-types.js';
import { BaseCommand } from '../types/BaseCommand.js';

export class GeolockCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('geolock')
    .setDescription(
      'Retrieves the restricted countries list for a given offer.'
    )
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('The query to search for.')
        .setAutocomplete(true)
    );

  private async search(query: string) {
    const data = await client
      .get<{
        hits: SingleOffer[];
      }>('/multisearch/offers', {
        params: {
          query,
        },
      })
      .then((res) => res.data);

    return data;
  }

  private async getOffer(id: string) {
    const data = await client
      .get<SingleOffer>(`/offers/${id}`)
      .then((res) => res.data);

    return data;
  }

  override async execute(interaction: CommandInteraction): Promise<void> {
    const id = interaction.options.get('query');

    if (!id) {
      await interaction.reply({
        content: 'Please provide an ID.',
        ephemeral: true,
      });
      return;
    }

    const data = await this.getOffer(id.value?.toString() || '').catch(() => null);

    if (!data) {
      await interaction.reply({
        content: 'No offer found with that ID.',
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(data.title)
      .setURL(
        `https://egdata.app/offers/${data.id}?utm_source=discord&utm_medium=bot&utm_campaign=offer`
      )
      .addFields([
        ...(data.countriesBlacklist
          ? [
            {
              name: 'Countries Blacklisted',
              value: (data.countriesBlacklist ?? []).join(', '),
            },
          ]
          : []),
        ...(data.countriesWhitelist
          ? [
            {
              name: 'Countries Whitelisted',
              value: (data.countriesWhitelist ?? []).join(', '),
            },
          ]
          : []),
      ])
      .setColor(0x00ff00)
      .setFooter({
        text: 'Check more offers on EGData.app',
        iconURL: 'https://cdn.discordapp.com/emojis/1226575784479686738.webp',
      })
      .setTimestamp(new Date(data.effectiveDate));

    await interaction.reply({
      embeds: [embed],
    });
  }

  override async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focusedValue = interaction.options.get('query');
    const query = focusedValue?.value || '';

    this.logger.info('Autocomplete query:', query);

    const data = await this.search(query.toString()).catch(() => null);

    if (!data) {
      await interaction.respond([]);
      return;
    }

    const results = data.hits;

    await interaction.respond(
      results.slice(0, 5).map((result) => ({
        name: `${result.title} (${offersDictionary[result.offerType] ?? result.offerType
          })`,
        value: result.id,
      }))
    );
  }
}

export default new GeolockCommand();
