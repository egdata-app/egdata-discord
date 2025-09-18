import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import type { SingleOffer } from '../types/offers.js';
import { client } from '../utils/client.js';
import { dedent } from 'ts-dedent';
import { BaseCommand } from '../types/BaseCommand.js';

interface Giveaway {
  _id: string;
  id: string;
  namespace: string;
  startDate: string;
  endDate: string;
  historical: Omit<Giveaway, 'historical'>[];
}

interface FreeGame extends SingleOffer {
  giveaway: Giveaway;
}

export class FreebiesCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('freebies')
    .setDescription('Retrieves the current giveaways on Epic Games Store.');

  private async getFreebies() {
    const data = await client
      .get<FreeGame[]>('/free-games')
      .then((res) => res.data);

    return data;
  }

  override async execute(interaction: CommandInteraction): Promise<void> {
    const data = await this.getFreebies();

    const embed = new EmbedBuilder()
      .setTitle('Current Giveaways')
      .setDescription(
        'Here are the current giveaways on Epic Games Store. Use the link below each giveaway to view more details on egdata.app.'
      )
      .setURL('https://egdata.app')
      .setColor(0x00ff00)
      .setTimestamp()
      .setFooter({ text: 'Powered by egdata.app' });

    for (const freebie of data) {
      const isEnded = new Date(freebie.giveaway.endDate) < new Date();
      const isOnGoing =
        new Date(freebie.giveaway.startDate) < new Date() &&
        new Date(freebie.giveaway.endDate) > new Date();
      const isUpcoming = new Date(freebie.giveaway.startDate) > new Date();

      if (isEnded) {
        continue;
      }

      const hasValidPrice = freebie.price?.price && 
        typeof freebie.price.price.originalPrice === 'number' && 
        !isNaN(freebie.price.price.originalPrice) &&
        freebie.price.price.originalPrice > 0;

      const priceFmtr = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: freebie.price?.price?.currencyCode || 'USD',
      });

      const repeatedText =
        freebie.giveaway.historical?.length > 1
          ? `(Repeated ${(freebie.giveaway.historical?.length ?? 1) - 1} times)`
          : '';

      // Validate dates to prevent invalid timestamps
      const startDate = new Date(freebie.giveaway.startDate);
      const endDate = new Date(freebie.giveaway.endDate);
      const targetDate = isOnGoing ? endDate : startDate;
      
      const isValidDate = !isNaN(targetDate.getTime());
      const timestamp = isValidDate ? Math.floor(targetDate.getTime() / 1000) : Math.floor(Date.now() / 1000);

      embed.addFields([
        {
          name: `${freebie.title}${hasValidPrice
              ? ` (${priceFmtr.format(
                freebie.price!.price.originalPrice / 100
              )})`
              : ''
            }`,
          value: `[View on egdata.app](https://egdata.app/offers/${freebie.id})`,
          inline: true,
        },
        {
          name: 'Status',
          value: dedent`${isOnGoing ? 'On Going' : isUpcoming ? 'Upcoming' : 'Ended'
            }
          ${repeatedText}`,
          inline: true,
        },
        {
          name: isOnGoing ? 'Ends' : 'Starts',
          value: `<t:${timestamp}:R>`,
          inline: true,
        },
      ]);
    }

    await interaction.reply({
      embeds: [embed],
    });
  }
}

export default new FreebiesCommand();
