import {AsyncValue} from './async-value';
import {ExternalsValidator} from './externals-validator';
import {
  FeatureServiceConsumerDefinition,
  FeatureServiceProviderDefinition,
  FeatureServiceRegistry,
  FeatureServices,
  SharedFeatureService
} from './feature-service-registry';
import {createUid} from './internal/create-uid';
import {isFeatureAppModule} from './internal/is-feature-app-module';
import {Logger} from './logger';

export interface FeatureAppEnvironment<
  TConfig,
  TInstanceConfig,
  TFeatureServices extends FeatureServices
> {
  /**
   * A config object that is provided by the integrator. The same config object
   * is used for all Feature App instances with the same ID, which is defined in
   * their {@link FeatureAppDefinition}.
   */
  readonly config: TConfig;

  /**
   * A config object that is intended for a specific Feature App instance.
   */
  readonly instanceConfig: TInstanceConfig;

  /**
   * An object of required Feature Services that are semver-compatible with the
   * declared dependencies in the Feature App definition.
   */
  readonly featureServices: TFeatureServices;

  /**
   * An optional ID specifier that distinguishes the Feature App instance from
   * other Feature App instances with the same ID.
   */
  readonly idSpecifier: string | undefined;
}

export interface FeatureAppDefinition<
  TFeatureApp,
  TConfig = unknown,
  TInstanceConfig = unknown,
  TFeatureServices extends FeatureServices = FeatureServices
> extends FeatureServiceConsumerDefinition {
  readonly ownFeatureServiceDefinitions?: FeatureServiceProviderDefinition<
    SharedFeatureService
  >[];

  create(
    env: FeatureAppEnvironment<TConfig, TInstanceConfig, TFeatureServices>
  ): TFeatureApp;
}

export type ModuleLoader = (url: string) => Promise<unknown>;

export interface FeatureAppScope<TFeatureApp> {
  readonly featureApp: TFeatureApp;

  destroy(): void;
}

export interface FeatureAppConfigs {
  readonly [featureAppId: string]: unknown;
}

export interface FeatureAppScopeOptions {
  /**
   * A specifier to distinguish the Feature App instances from others created
   * from the same definition.
   */
  readonly idSpecifier?: string;

  /**
   * A config object that is intended for a specific Feature App instance.
   */
  readonly instanceConfig?: unknown;
}

/**
 * @deprecated Use {@link FeatureAppManager} instead.
 */
export type FeatureAppManagerLike = FeatureAppManager;

export interface FeatureAppManagerOptions {
  /**
   * Configurations for all Feature Apps that will potentially be created.
   */
  readonly configs?: FeatureAppConfigs;

  /**
   * For the `FeatureAppManager` to be able to load Feature Apps from a remote
   * location, a module loader must be provided, (e.g. the
   * `@feature-hub/module-loader-amd` package or the
   * `@feature-hub/module-loader-commonjs` package).
   */
  readonly moduleLoader?: ModuleLoader;

  /**
   * When using a {@link #moduleLoader}, it might make sense to validate
   * external dependencies that are required by Feature Apps against the
   * shared dependencies that are provided by the integrator. This makes it
   * possible that an error is already thrown when creating a Feature App with
   * incompatible external dependencies, and thus enables early feedback as to
   * whether a Feature App is compatible with the integration environment.
   */
  readonly externalsValidator?: ExternalsValidator;

  /**
   * A custom logger that shall be used instead of `console`.
   */
  readonly logger?: Logger;
}

type FeatureAppModuleUrl = string;
type FeatureAppUid = string;

/**
 * The `FeatureAppManager` manages the lifecycle of Feature Apps.
 */
export class FeatureAppManager {
  private readonly asyncFeatureAppDefinitions = new Map<
    FeatureAppModuleUrl,
    AsyncValue<FeatureAppDefinition<unknown>>
  >();

  private readonly featureAppDefinitionsWithRegisteredOwnFeatureServices = new WeakSet<
    FeatureAppDefinition<unknown>
  >();

  private readonly featureAppScopes = new Map<
    FeatureAppUid,
    FeatureAppScope<unknown>
  >();

  private readonly logger: Logger;

  public constructor(
    private readonly featureServiceRegistry: FeatureServiceRegistry,
    private readonly options: FeatureAppManagerOptions = {}
  ) {
    this.logger = options.logger || console;
  }

  /**
   * Load a {@link FeatureAppDefinition} using the module loader the
   * {@link FeatureAppManager} was initilized with.
   *
   * @throws Throws an error if no module loader was provided on initilization.
   *
   * @param url A URL pointing to a {@link FeatureAppDefinition} bundle in a
   * module format compatible with the module loader.
   *
   * @returns An {@link AsyncValue} containing a promise that resolves with the
   * loaded {@link FeatureAppDefinition}. If called again with the same URL it
   * returns the same {@link AsyncValue}. The promise rejects when loading
   * fails, or when the loaded bundle doesn't export a {@link
   * FeatureAppDefinition} as default.
   */
  public getAsyncFeatureAppDefinition(
    url: string
  ): AsyncValue<FeatureAppDefinition<unknown>> {
    let asyncFeatureAppDefinition = this.asyncFeatureAppDefinitions.get(url);

    if (!asyncFeatureAppDefinition) {
      asyncFeatureAppDefinition = this.createAsyncFeatureAppDefinition(url);

      this.asyncFeatureAppDefinitions.set(url, asyncFeatureAppDefinition);
    }

    return asyncFeatureAppDefinition;
  }

  /**
   * Create a {@link FeatureAppScope} which includes validating externals,
   * binding all available Feature Service dependencies, and calling the
   * `create` method of the {@link FeatureAppDefinition}.
   *
   * @throws Throws an error if Feature Services that the {@link
   * FeatureAppDefinition} provides with its `ownFeatureServices` key fail to
   * be registered.
   * @throws Throws an error if the required externals can't be satisfied.
   * @throws Throws an error if the required Feature Services can't be
   * satisfied.
   * @throws Throws an error the {@link FeatureAppDefinition}'s `create` method
   * throws.
   *
   * @param featureAppDefinition The definition of the Feature App to create a
   * scope for.
   *
   * @returns A {@link FeatureAppScope} for the provided {@link
   * FeatureAppDefinition} and ID specifier. If `getFeatureAppScope` is called
   * multiple times with the same {@link FeatureAppDefinition} and ID specifier,
   * it returns the {@link FeatureAppScope} it created on the first call.
   */
  public getFeatureAppScope<TFeatureApp>(
    featureAppDefinition: FeatureAppDefinition<TFeatureApp>,
    options: FeatureAppScopeOptions = {}
  ): FeatureAppScope<TFeatureApp> {
    const {idSpecifier, instanceConfig} = options;
    const {id: featureAppId} = featureAppDefinition;
    const featureAppUid = createUid(featureAppId, idSpecifier);

    let featureAppScope = this.featureAppScopes.get(featureAppUid);

    if (!featureAppScope) {
      this.registerOwnFeatureServices(featureAppDefinition);

      const deleteFeatureAppScope = () =>
        this.featureAppScopes.delete(featureAppUid);

      featureAppScope = this.createFeatureAppScope(
        featureAppDefinition,
        idSpecifier,
        instanceConfig,
        deleteFeatureAppScope
      );

      this.featureAppScopes.set(featureAppUid, featureAppScope);
    }

    return featureAppScope as FeatureAppScope<TFeatureApp>;
  }

  /**
   * Preload a {@link FeatureAppDefinition} using the module loader the {@link
   * FeatureAppManager} was initilized with. Useful before hydration of a
   * server rendered page to avoid render result mismatch between client and
   * server due missing {@link FeatureAppDefinition}s.
   *
   * @throws Throws an error if no module loader was provided on initilization.
   *
   * @see {@link getAsyncFeatureAppDefinition} for further information.
   */
  public async preloadFeatureApp(url: string): Promise<void> {
    await this.getAsyncFeatureAppDefinition(url).promise;
  }

  private createAsyncFeatureAppDefinition(
    url: string
  ): AsyncValue<FeatureAppDefinition<unknown>> {
    const {moduleLoader: loadModule} = this.options;

    if (!loadModule) {
      throw new Error('No module loader provided.');
    }

    return new AsyncValue(
      loadModule(url).then(featureAppModule => {
        if (!isFeatureAppModule(featureAppModule)) {
          throw new Error(
            `The Feature App module at the url ${JSON.stringify(
              url
            )} is invalid. A Feature App module must have a Feature App definition as default export. A Feature App definition is an object with at least an \`id\` string and a \`create\` method.`
          );
        }

        this.logger.info(
          `The Feature App module at the url ${JSON.stringify(
            url
          )} has been successfully loaded.`
        );

        return featureAppModule.default;
      })
    );
  }

  private registerOwnFeatureServices(
    featureAppDefinition: FeatureAppDefinition<unknown>
  ): void {
    if (
      this.featureAppDefinitionsWithRegisteredOwnFeatureServices.has(
        featureAppDefinition
      )
    ) {
      return;
    }

    if (featureAppDefinition.ownFeatureServiceDefinitions) {
      this.featureServiceRegistry.registerFeatureServices(
        featureAppDefinition.ownFeatureServiceDefinitions,
        featureAppDefinition.id
      );
    }

    this.featureAppDefinitionsWithRegisteredOwnFeatureServices.add(
      featureAppDefinition
    );
  }

  private createFeatureAppScope<TFeatureApp>(
    featureAppDefinition: FeatureAppDefinition<TFeatureApp>,
    idSpecifier: string | undefined,
    instanceConfig: unknown,
    deleteFeatureAppScope: () => void
  ): FeatureAppScope<TFeatureApp> {
    this.validateExternals(featureAppDefinition);

    const {configs} = this.options;
    const config = configs && configs[featureAppDefinition.id];
    const featureAppUid = createUid(featureAppDefinition.id, idSpecifier);

    const binding = this.featureServiceRegistry.bindFeatureServices(
      featureAppDefinition,
      idSpecifier
    );

    const featureApp = featureAppDefinition.create({
      config,
      instanceConfig,
      featureServices: binding.featureServices,
      idSpecifier
    });

    this.logger.info(
      `The Feature App ${JSON.stringify(
        featureAppUid
      )} has been successfully created.`
    );

    let destroyed = false;

    const destroy = () => {
      if (destroyed) {
        throw new Error(
          `The Feature App ${JSON.stringify(
            featureAppUid
          )} could not be destroyed.`
        );
      }

      deleteFeatureAppScope();
      binding.unbind();

      destroyed = true;
    };

    return {featureApp, destroy};
  }

  private validateExternals(
    featureAppDefinition: FeatureServiceConsumerDefinition
  ): void {
    const {externalsValidator} = this.options;

    if (!externalsValidator) {
      return;
    }

    const {dependencies} = featureAppDefinition;

    if (dependencies && dependencies.externals) {
      externalsValidator.validate(dependencies.externals);
    }
  }
}
