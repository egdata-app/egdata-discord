import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
} from 'discord.js';
import { client } from '../utils/client.js';
import type { SingleItem } from '../types/items.js';
import { getImage } from '../utils/get-image.js';
import type { Asset } from '../types/asset.js';
import { BaseCommand } from '../types/BaseCommand.js';

export class AssetsCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('assets')
    .setDescription('Retrieves the assets for a specific game.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('The query to search for.')
        .setAutocomplete(true)
    );

  private async search(query: string) {
    const data = await client
      .get<{
        hits: SingleItem[];
      }>('/multisearch/items', {
        params: {
          query,
          type: 'EXECUTABLE',
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

  private async getItemAssets(id: string) {
    const data = await client
      .get<Asset[]>(`/items/${id}/assets`)
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

    const [itemRaw, assetsRaw] = await Promise.allSettled([
      this.getItem(id.value?.toString() || ''),
      this.getItemAssets(id.value?.toString() || ''),
    ]);
    const item = itemRaw.status === 'fulfilled' ? itemRaw.value : null;
    const assets = assetsRaw.status === 'fulfilled' ? assetsRaw.value : null;

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
      .setTimestamp(new Date(item.lastModifiedDate))
      .addFields(
        (assets ?? []).map((asset) => ({
          name: asset.platform,
          value: `Download size: ${formatBytes(
            asset.downloadSizeBytes
          )}\nInstalled size: ${formatBytes(asset.installedSizeBytes)}`,
          inline: false,
        }))
      );

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
        name: `${result.title}`,
        value: result.id,
      }))
    );
  }
}

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

export default new AssetsCommand();
