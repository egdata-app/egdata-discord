import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
} from 'discord.js';
import { client } from '../utils/client.js';
import type { SingleItem } from '../types/items.js';
import { getImage } from '../utils/get-image.js';
import { BaseCommand } from '../types/BaseCommand.js';

export class ItemsCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('item')
    .setDescription('Retrieves the latest item from the EGData API.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('The query to search for.')
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('The type of item to search for.')
        .setChoices([
          { name: 'Game', value: 'EXECUTABLE' },
          { name: 'Audience', value: 'AUDIENCE' },
        ])
        .setRequired(false)
    );

  private async search(query: string, type?: string) {
    const data = await client
      .get<{
        hits: SingleItem[];
      }>('/multisearch/items', {
        params: {
          query,
          type,
        },
      })
      .then((res) => res.data);

    return data;
  }

  private async getItem(id: string) {
    const data = await client
      .get<SingleItem>(`/items/${id}`)
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

    const [itemRaw] = await Promise.allSettled([
      this.getItem(id.value?.toString() || ''),
    ]);
    const item = itemRaw.status === 'fulfilled' ? itemRaw.value : null;

    if (!item) {
      await interaction.reply({
        content: 'No item found with that ID.',
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(item.title)
      .setURL(
        `https://egdata.app/items/${item.id}?utm_source=discord&utm_medium=bot&utm_campaign=item`
      )
      .setThumbnail(
        getImage(item.keyImages, [
          'DieselGameBoxTall',
          'DieselStoreFrontTall',
        ])?.url.replaceAll(' ', '%20') ?? 'https://egdata.app/placeholder.webp'
      )
      .setColor(0x00ff00)
      .setTimestamp(new Date(item.lastModifiedDate));

    await interaction.reply({
      embeds: [embed],
    });
  }

  override async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focusedValue = interaction.options.get('query');
    const type = interaction.options.get('type');
    const query = focusedValue?.value || '';

    this.logger.info('Autocomplete query:', query);

    const data = await this.search(
      query.toString(),
      type?.value?.toString() ?? undefined
    ).catch(() => null);

    if (!data) {
      await interaction.respond([]);
      return;
    }

    const results = data.hits;

    await interaction.respond(
      results.slice(0, 5).map((result) => ({
        name: `${result.title} (${result.entitlementType})`,
        value: result.id,
      }))
    );
  }
}

export default new ItemsCommand();
