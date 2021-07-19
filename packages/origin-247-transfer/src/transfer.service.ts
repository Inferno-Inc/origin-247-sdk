import { Inject, Injectable } from '@nestjs/common';
import { CertificateService, CERTIFICATE_SERVICE_TOKEN } from '@energyweb/origin-247-certificate';
import {
    EnergyTransferRequestRepository,
    ENERGY_TRANSFER_REQUEST_REPOSITORY
} from './repositories/EnergyTransferRequest.repository';
import { GenerationReadingStoredPayload } from './events/GenerationReadingStored.event';
import { QueryBus, CommandBus, EventBus } from '@nestjs/cqrs';
import {
    GetTransferSitesQuery,
    IGetTransferSitesQueryResponse
} from './queries/GetTransferSites.query';
import { Logger } from '@nestjs/common';
import {
    ValidateTransferCommandCtor,
    VALIDATE_TRANSFER_COMMANDS_TOKEN
} from './commands/ValidateTransferCommand';
import {
    EnergyTransferRequest,
    TransferValidationStatus,
    UpdateStatusCode
} from './EnergyTransferRequest';
import { ValidatedTransferRequestEvent } from './events';

interface IIssueCommand extends GenerationReadingStoredPayload<unknown> {}

export interface IUpdateValidationStatusCommand {
    requestId: number;
    status: TransferValidationStatus;
    validatorName: string;
}

@Injectable()
export class TransferService {
    private readonly logger = new Logger(TransferService.name);

    constructor(
        @Inject(CERTIFICATE_SERVICE_TOKEN)
        private certificateService: CertificateService<unknown>,
        @Inject(ENERGY_TRANSFER_REQUEST_REPOSITORY)
        private energyTransferRequestRepository: EnergyTransferRequestRepository,
        @Inject(VALIDATE_TRANSFER_COMMANDS_TOKEN)
        private validateCommands: ValidateTransferCommandCtor[],
        private queryBus: QueryBus,
        private commandBus: CommandBus,
        private eventBus: EventBus
    ) {}

    public async issue(command: IIssueCommand): Promise<void> {
        const { generatorId, energyValue, transferDate, fromTime, toTime, metadata } = command;

        const sites: IGetTransferSitesQueryResponse | null = await this.queryBus.execute(
            new GetTransferSitesQuery({ generatorId })
        );

        if (!sites) {
            this.logger.log(`No sites queries for ${generatorId}`);
            return;
        }

        const request = await this.energyTransferRequestRepository.createNew({
            buyerAddress: sites.buyerAddress,
            sellerAddress: sites.sellerAddress,
            volume: energyValue,
            generatorId,
            transferDate
        });

        const certificate = await this.certificateService.issue({
            deviceId: generatorId,
            energyValue: energyValue,
            fromTime,
            toTime,
            userId: sites.sellerAddress,
            toAddress: sites.sellerAddress,
            metadata
        });

        request.updateCertificateId(certificate.id);

        await this.energyTransferRequestRepository.save(request);

        // There is a risk of race condition between `issue` finish and `CertificatePersistedEvent`
        // If certificate is already persisted (it can be found by service)
        // Then we should proceed as we received the event

        const isCertificatePersisted = Boolean(
            await this.certificateService.getById(certificate.id)
        );

        if (isCertificatePersisted) {
            await this.persistRequestCertificate(certificate.id);
        }
    }

    public async persistRequestCertificate(certificateId: number): Promise<void> {
        const request = await this.energyTransferRequestRepository.findByCertificateId(
            certificateId
        );

        if (!request) {
            this.logger.warn(`
                No transfer request found for certificate: ${certificateId}.
                This can mean, that there was a race condition, and CertificatePersisted event was received,
                before we could save the certificate id on ETR.
            `);

            return;
        }

        request.markCertificatePersisted();

        await this.energyTransferRequestRepository.save(request);

        await this.startValidation(request);
    }

    private async startValidation(request: EnergyTransferRequest): Promise<void> {
        request.startValidation(this.validateCommands.map((c) => c.name));

        await this.energyTransferRequestRepository.save(request);

        // If request is immediately valid (which may happen if no validators are supplied)
        if (request.isValid()) {
            this.eventBus.publish(
                new ValidatedTransferRequestEvent({
                    requestId: request.id
                })
            );

            return;
        }

        await Promise.all(
            this.validateCommands.map(async (Command) => {
                const result = await this.executeCommand(Command, request);

                await this.updateValidationStatus({
                    validatorName: Command.name,
                    requestId: request.id,
                    status: result.validationResult
                });
            })
        );
    }

    public async updateValidationStatus(command: IUpdateValidationStatusCommand): Promise<void> {
        const { requestId, validatorName: commandName, status } = command;

        await this.energyTransferRequestRepository.updateWithLock(requestId, (request) => {
            const result = request.updateValidationStatus(commandName, status);

            switch (result) {
                case UpdateStatusCode.NoValidator:
                    throw new Error(
                        `Cannot update status of transfer request: ${requestId}, because validator "${commandName}" is not present`
                    );
                case UpdateStatusCode.NotPending:
                    this.logger.warn(
                        `Skipping update of transfer request: ${requestId} to ${status}, because it is not pending`
                    );
                    return;
                default:
                    return;
            }
        });

        // This has to be run/checked after the transaction above finishes
        const request = await this.energyTransferRequestRepository.findById(requestId);

        if (request && request.isValid()) {
            this.eventBus.publish(
                new ValidatedTransferRequestEvent({
                    requestId: request.id
                })
            );
        }
    }

    public async transferCertificate(requestId: number): Promise<void> {
        const request = await this.energyTransferRequestRepository.findById(requestId);

        if (!request) {
            this.logger.error(
                `Received transfer request for request ${requestId}, but not such found`
            );
            return;
        }

        if (!request.certificateId) {
            this.logger.error(
                `Received transfer request for request ${requestId}, but this request has no certificate`
            );
            return;
        }

        if (!request.isValid()) {
            this.logger.error(
                `Received transfer request for request ${requestId}, but this request is not valid`
            );
            return;
        }

        await this.certificateService.transfer({
            certificateId: request.certificateId,
            fromAddress: request.sites.sellerAddress,
            toAddress: request.sites.buyerAddress,
            energyValue: request.volume
        });
    }

    private async executeCommand(
        Command: ValidateTransferCommandCtor,
        request: EnergyTransferRequest
    ) {
        try {
            const command = new Command(request.toPublicAttrs());

            return await this.commandBus.execute(command);
        } catch (e) {
            this.logger.error(`
                One of validation commands (${Command.name}) returned error for request: ${request.id}:
                "${e.message}"
            `);

            return { validationResult: TransferValidationStatus.Error };
        }
    }
}