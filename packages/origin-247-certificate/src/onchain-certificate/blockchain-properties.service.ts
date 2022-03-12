import { Injectable } from '@nestjs/common';
import { Contracts, IBlockchainProperties } from '@energyweb/issuer';
import { ConfigService } from '@nestjs/config';
import { DeploymentPropertiesRepository } from './repositories/deploymentProperties/deploymentProperties.repository';
import { providers, Signer, Wallet } from 'ethers';
import { getProviderWithFallback } from '@energyweb/utils-general';
import { waitForState } from '../utils/wait.utils';

@Injectable()
export class BlockchainPropertiesService {
    private readonly primaryRPC: string;
    private readonly issuerPrivateKey: string;

    constructor(
        private configService: ConfigService<{ WEB3: string; ISSUER_PRIVATE_KEY: string }>,
        private deploymentPropsRepo: DeploymentPropertiesRepository
    ) {
        const primaryRPC = this.configService.get('WEB3');
        const issuerPrivateKey = this.configService.get('ISSUER_PRIVATE_KEY');

        if (!primaryRPC) {
            throw new Error('No WEB3 environment variable set');
        }

        if (!issuerPrivateKey) {
            throw new Error('No ISSUER_PRIVATE_KEY environment variable set');
        }

        this.primaryRPC = primaryRPC;
        this.issuerPrivateKey = issuerPrivateKey;
    }

    async getProperties(): Promise<IBlockchainProperties> {
        await waitForState(
            async () => await this.isDeployed(),
            'Blockchain properties were not deployed',
            { interval: 5_000, maxTries: 24 }
        );

        const { registry, issuer } = await this.deploymentPropsRepo.get();

        const web3 = getProviderWithFallback(...[this.primaryRPC].filter((url) => Boolean(url)));

        const signer: Signer = new Wallet(this.assure0x(this.issuerPrivateKey), web3);

        return {
            web3,
            registry: Contracts.factories.RegistryExtendedFactory.connect(registry, signer),
            issuer: Contracts.factories.IssuerFactory.connect(issuer, signer),
            activeUser: signer
        };
    }

    async deploy(): Promise<void> {
        if (await this.deploymentPropsRepo.propertiesExist()) {
            return;
        }

        const provider = new providers.FallbackProvider([
            new providers.JsonRpcProvider(this.primaryRPC)
        ]);

        const registry = await Contracts.migrateRegistry(provider, this.issuerPrivateKey);
        const issuer = await Contracts.migrateIssuer(
            provider,
            this.issuerPrivateKey,
            registry.address
        );

        await this.deploymentPropsRepo.save({ registry: registry.address, issuer: issuer.address });
    }

    async isDeployed(): Promise<boolean> {
        return await this.deploymentPropsRepo.propertiesExist();
    }

    async wrap(privateKey: string) {
        const { registry, issuer } = await this.deploymentPropsRepo.get();

        const { web3 } = await this.getProperties();

        const signer: Signer = new Wallet(this.assure0x(privateKey), web3);
        return {
            web3,
            registry: Contracts.factories.RegistryExtendedFactory.connect(registry, signer),
            issuer: Contracts.factories.IssuerFactory.connect(issuer, signer),
            activeUser: signer
        };
    }

    private assure0x = (privateKey: string) =>
        privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
}