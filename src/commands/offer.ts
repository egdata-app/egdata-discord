// ...other code...

.addFields([
  {
    name: `Price${data.offerType === 'BASE_GAME' && usPrice?.price.discountPrice === 19999 ? ' (Placeholder)' : ''}`,
    value: `${usPrice ? `${usFmtr.format(usPrice.price.discountPrice / 100)}` : ''} / ${eurPrice ? `${eurFmtr.format(eurPrice.price.discountPrice / 100)}` : ''}`,
    inline: true,
  },
  // ...rest of the fields...
])

// ...other code...