export default async function* reporter(source) {
  for await (const event of source) {
    if (['test:pass','test:fail','test:diagnostic','test:plan'].includes(event.type))
      yield JSON.stringify(event) + '\n';
  }
}
