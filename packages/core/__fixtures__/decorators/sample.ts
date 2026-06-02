function Injectable(): ClassDecorator {
  return (target) => {};
}

function Log(): MethodDecorator {
  return () => {};
}

@Injectable()
export class AppService {
  @Log()
  handle(): void {}
}
