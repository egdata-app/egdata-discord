import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
} from 'discord.js';
import { client } from '../utils/client.js';
import type { SingleOffer } from '../types/offers.js';
import { dedent } from 'ts-dedent';
import { BaseCommand } from '../types/BaseCommand.js';

interface Seller {
  _id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  igdb_id?: string;
  logo?: {
    _id: string;
    url: string;
    height: number;
    width: number;
    checksum: string;
    animated: boolean;
    alpha_channel: boolean;
  };
}

export class SellerCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('seller')
    .setDescription('Retrieves a seller from the EGData API.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('The query to search for.')
        .setAutocomplete(true)
    );

  private async search(query: string) {
    const data = await client
      .get<{
        hits: Seller[];
      }>('/multisearch/sellers', {
        params: {
          query,
        },
      })
      .then((res) => res.data);

    return data;
  }

  private async getSeller(id: string) {
    const data = await client
      .get<{
        offers: number;
        items: number;
        games: number;
        freegames: number;
        seller: Seller;
      }>(`/sellers/${id}/stats`)
      .then((res) => res.data);

    return data;
  }

  private async getCovers(id: string) {
    const data = await client
      .get<SingleOffer[]>(`/sellers/${id}/cover`)
      .then((res) => res.data);

    return data;
  }

  private formatLogo(logo: string) {
    return logo.startsWith('//')
      ? `https:${logo.replace('t_thumb', 't_1080p').replace('.jpg', '.webp')}`
      : logo;
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

    const [sellerRaw, coversRaw] = await Promise.allSettled([
      this.getSeller(id.value?.toString() || ''),
      this.getCovers(id.value?.toString() || ''),
    ]);

    const seller = sellerRaw.status === 'fulfilled' ? sellerRaw.value : null;
    const covers = coversRaw.status === 'fulfilled' ? coversRaw.value : null;

    if (!seller) {
      await interaction.reply({
        content: 'No seller found with that ID.',
        ephemeral: true,
      });
      return;
    }

    // Create an embed to showcase the seller's information
    const embed = new EmbedBuilder()
      .setTitle(seller.seller.name)
      .setURL(
        `https://egdata.app/sellers/${seller.seller._id}?utm_source=discord&utm_medium=bot&utm_campaign=seller`
      )
      .setThumbnail(
        this.formatLogo(
          seller.seller.logo?.url ?? 'https://egdata.app/placeholder.webp'
        )
      )
      .setColor(0x00ff00)
      .setTimestamp(new Date(seller.seller.updatedAt))
      .addFields([
        {
          name: 'Games',
          value: `${seller.games}`,
          inline: true,
        },
        {
          name: 'Offers',
          value: `${seller.offers}`,
          inline: true,
        },
        {
          name: ' ',
          value: ' ',
          inline: true,
        },
        {
          name: 'Items',
          value: seller.items.toString(),
          inline: true,
        },
        {
          name: 'Giveaways',
          value: seller.freegames.toString(),
          inline: true,
        },
        {
          name: ' ',
          value: ' ',
          inline: true,
        },
        {
          name: 'Top Sellers',
          value: dedent`${covers
            ?.map((cover) => {
              return `- [${cover.title}](https://egdata.app/offers/${cover.id}?utm_source=discord&utm_medium=bot&utm_campaign=seller)`;
            })
            .join('\n')}`,
        },
      ]);

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
        name: result.name,
        value: result._id,
      }))
    );
  }
}

export default new SellerCommand();
