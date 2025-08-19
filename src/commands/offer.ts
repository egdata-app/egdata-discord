import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
} from 'discord.js';
import type { SingleOffer } from '../types/offers.js';
import { getImage } from '../utils/get-image.js';
import { client } from '../utils/client.js';
import { offersDictionary } from '../utils/offer-types.js';
import { type Genre, genres } from '../utils/genres.js';
import { BaseCommand } from '../types/BaseCommand.js';
import type { SearchResponse, OfferMediaResponse, PriceResponse, TopsResponse } from '../types/api.js';

const mobilePlatforms = ['39070', '39071'];

const mobileNames: Record<string, string> = {
  '39070': 'iOS',
  '39071': 'Android',
};

export class OfferCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('offer')
    .setDescription('Retrieves the latest offer from the EGData API.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('The query to search for.')
        .setAutocomplete(true)
    );

  private async search(query: string) {
    const data = await client
      .get<SearchResponse>('/multisearch/offers', {
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

  private async getOfferMedia(offer: SingleOffer) {
    return client
      .get<OfferMediaResponse>(`/offers/${offer.id}/media`)
      .then((res) => res.data)
      .catch(() => null);
  }

  private async getPrice(id: string, country: string) {
    return client
      .get<PriceResponse>(`/offers/${id}/price`, {
        params: {
          country,
        },
      })
      .then((res) => res.data)
      .catch(() => null);
  }

  private async getTops(id: string) {
    return client
      .get<TopsResponse>(`/offers/${id}/tops`)
      .then((res) => {
        const data = res.data;
        return data;
      })
      .catch((err) => {
        this.logger.error('Failed to fetch tops:', err);
        return null;
      });
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

    this.logger.info(`User requested offer ${data.id}`);

    const [offerMediaRaw, allGenresRaw, priceUS, priceEUR, rawTops] =
      await Promise.allSettled([
        this.getOfferMedia(data),
        genres(),
        this.getPrice(data.id, 'US'),
        this.getPrice(data.id, 'ES'),
        this.getTops(data.id),
      ]);

    const offerMedia =
      offerMediaRaw.status === 'fulfilled' ? offerMediaRaw.value : null;
    const allGenres = allGenresRaw.status === 'fulfilled' ? allGenresRaw.value : [];
    const usPrice = priceUS.status === 'fulfilled' ? priceUS.value : null;
    const eurPrice = priceEUR.status === 'fulfilled' ? priceEUR.value : null;
    const tops = rawTops.status === 'fulfilled' ? rawTops.value : null;

    const usFmtr = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    });
    const eurFmtr = new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'EUR',
    });

    const embed = new EmbedBuilder()
      .setTitle(data.title)
      .setURL(data.url)
      .setThumbnail(getImage(data))
      .setDescription(data.description)
      .addFields([
        {
          name: 'Type',
          value: offersDictionary[data.offerType],
          inline: true,
        },
        {
          name: `Price${
            data.offerType === 'BASE_GAME' && usPrice?.price.discountPrice === 19999
              ? ' (Placeholder)'
              : ''
          }`,
          value: `${usPrice ? `${usFmtr.format(usPrice.price.discountPrice / 100)}` : ''} / ${
            eurPrice ? `${eurFmtr.format(eurPrice.price.discountPrice / 100)}` : ''
          }`,
          inline: true,
        },
        {
          name: 'Genres',
          value: data.genres.map((g: Genre) => g.name).join(', ') || 'N/A',
          inline: true,
        },
      ]);

    await interaction.reply({ embeds: [embed] });
  }
}