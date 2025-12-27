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

const discordEmojis = {
  "39070": "<:ios:1373245956060872824>",
  "39071": "<:android:1373245268912373891>",
} as Record<string, string>;

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
    const allGenres =
      allGenresRaw.status === 'fulfilled' ? allGenresRaw.value : [];
    const usPrice = priceUS.status === 'fulfilled' ? priceUS.value : null;
    const eurPrice = priceEUR.status === 'fulfilled' ? priceEUR.value : null;
    const tops = rawTops.status === 'fulfilled' ? rawTops.value : null;

    const hasMobile = data.tags.some((tag) => mobilePlatforms.includes(tag.id));

    const eurFmtr = new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'EUR',
    });
    const usFmtr = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    });

    const offerGenres = data.tags
      .map((tag) => allGenres.find((genre) => genre.id === tag.id))
      .filter((genre) => genre);

    const footerText = () => {
      if (tops) {
        const text: string[] = [];

        if (tops['top-wishlisted']) {
          text.push(`🔥 #${tops['top-wishlisted']} wishlisted`);
        }
        if (tops['top-sellers']) {
          text.push(`💰 #${tops['top-sellers']} top seller`);
        }
        if (tops['top-demos']) {
          text.push(`🎮 #${tops['top-demos']} top demos`);
        }
        if (tops['top-new-releases']) {
          text.push(`🆕 #${tops['top-new-releases']} top new releases`);
        }
        if (tops['most-played']) {
          text.push(`🎉 #${tops['most-played']} most played`);
        }
        if (tops['top-player-reviewed']) {
          text.push(`⭐ #${tops['top-player-reviewed']} top player reviewed`);
        }
        if (tops['most-popular']) {
          text.push(`🚀 #${tops['most-popular']} most popular`);
        }
        if (tops['top-free-to-play']) {
          text.push(`🆓 #${tops['top-free-to-play']} top free to play`);
        }
        if (tops['top-add-ons']) {
          text.push(`➕ #${tops['top-add-ons']} top add-ons`);
        }

        // Return joined text if we have entries
        if (text.length) {
          return text.join(' • ');
        }
      }

      return 'Check more offers on egdata.app';
    };

    const platformEmojis = [] as string[];

    if (hasMobile) {
      data.tags.forEach((tag) => {
        if (discordEmojis[tag.id]) {
          platformEmojis.push(discordEmojis[tag.id] as string);
        }
      })
    }

    const embed = new EmbedBuilder()
      .setTitle(`${data.title}${data.prePurchase ? ' (Pre-Purchase)' : ''}${platformEmojis.join(' ')}`)
      .setDescription(data.description)
      .setURL(
        `https://egdata.app/offers/${data.id}?utm_source=discord&utm_medium=bot&utm_campaign=offer`
      )
      .setThumbnail(
        getImage(data.keyImages, [
          'CodeRedemption_340x440',
          'DieselGameBoxTall',
          'DieselStoreFrontTall',
          'OfferImageTall',
        ])?.url.replaceAll(' ', '%20') ?? 'https://egdata.app/placeholder.webp'
      )
      .addFields([
        {
          name: `Price${data.offerType === 'BASE_GAME' && usPrice?.price.discountPrice === 19999
            ? ' (Placeholder)'
            : ''
            }`,
          value: `${usPrice ? `${usFmtr.format(usPrice.price.discountPrice / 100)}` : ''} / ${eurPrice ? `${eurFmtr.format(eurPrice.price.discountPrice / 100)}` : ''
            }`,
          inline: true,
        },
        {
          name: 'Release Date',
          value: `<t:${Math.floor(
            new Date(data.releaseDate ?? data.effectiveDate).getTime() / 1000
          )}:R>`,
          inline: true,
        },
        {
          name: 'Developer',
          value: data.developerDisplayName ?? data.seller.name,
          inline: true,
        },
        {
          name: 'Publisher',
          value: data.publisherDisplayName ?? data.seller.name,
          inline: true,
        },
        {
          name: 'Genres',
          value:
            offerGenres.length > 0
              ? offerGenres
                .map((genre: Genre | undefined) => {
                  if (genre) {
                    return `[${genre.name}](https://egdata.app/search?tags=${genre.id})`;
                  }
                  return '';
                })
                .join(', ')
              : 'No genres',
          inline: true,
        },
        {
          name: 'Type',
          value: offersDictionary[data.offerType] ?? data.offerType,
          inline: true,
        },
      ])
      .setColor(0x00ff00)
      .setAuthor({
        name: data.seller.name,
      })
      .setFooter({
        text:
          footerText() !== ''
            ? footerText()
            : 'Check more offers on egdata.app',
        iconURL: 'https://egdata.app/logo_simple_white.png',
      })
      .setTimestamp(new Date(data.lastModifiedDate));

    const images = (offerMedia?.images ?? []).map((image) =>
      new EmbedBuilder()
        .setURL(
          `https://egdata.app/offers/${data.id}?utm_source=discord&utm_medium=bot&utm_campaign=offer`
        )
        .setImage(image.src)
    );

    if (images.length > 3) {
      images.unshift(
        new EmbedBuilder()
          .setURL(
            `https://egdata.app/offers/${data.id}?utm_source=discord&utm_medium=bot&utm_campaign=offer`
          )
          .setImage(
            getImage(data.keyImages, [
              'CodeRedemption_340x440',
              'DieselGameBoxTall',
              'DieselStoreFrontTall',
              'OfferImageTall',
            ])?.url ?? 'https://egdata.app/placeholder.webp'
          )
      );
    }

    await interaction.reply({
      embeds: [embed, ...images.slice(0, 3)],
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

    // Create a map to track duplicate titles
    const titleCount = new Map<string, number>();
    results.forEach(result => {
      titleCount.set(result.title, (titleCount.get(result.title) || 0) + 1);
    });

    await interaction.respond(
      results.slice(0, 5).map((result) => {
        const isMobile = result.tags.some(tag => mobilePlatforms.includes(tag.id));
        const isDuplicate = (titleCount.get(result.title) || 0) > 1;

        this.logger.debug('Processing result:', {
          title: result.title,
          duplicateCount: titleCount.get(result.title),
          result
        });

        let suffix = '';
        if (isMobile) {
          suffix = ` (${mobileNames[result.tags.find(tag => mobilePlatforms.includes(tag.id))?.id ?? '']})`;
        } else if (isDuplicate) {
          suffix = ` [${result.id.slice(0, 5)}]`;
        }

        return {
          name: `${result.title}${result.prePurchase ? ' (Pre-Purchase)' : ''} (${offersDictionary[result.offerType] ?? result.offerType})${suffix}`,
          value: result.id,
        };
      })
    );
  }
}

export default new OfferCommand();
