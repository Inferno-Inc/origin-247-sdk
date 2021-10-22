import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { CommandBus } from '@nestjs/cqrs';
import { BlockchainAction, BlockchainActionType } from './types';
import { BigNumber } from 'ethers';
import {
    ClaimCertificateCommand,
    IssueCertificateCommand,
    TransferCertificateCommand,
    BatchClaimCertificatesCommand,
    BatchIssueCertificatesCommand,
    BatchTransferCertificatesCommand
} from '@energyweb/issuer-api';
import { TransactionPollService } from './transaction-poll.service';

@Processor('blockchain-actions')
export class BlockchainActionsProcessor {
    private readonly logger = new Logger(BlockchainActionsProcessor.name);

    constructor(private commandBus: CommandBus, private transactionPoll: TransactionPollService) {}

    @Process({ concurrency: 1 })
    async handle(payload: Job<BlockchainAction>): Promise<unknown> {
        try {
            const result = await this.process(payload);

            /**
             * Sometimes we get conflicting nonce/gas price problem.
             * Therefore we need to give some time to process everything.
             */
            await new Promise((resolve) =>
                setTimeout(resolve, Number(process.env.CERTIFICATE_QUEUE_DELAY ?? 10000))
            );

            return result;
        } catch (e) {
            this.logger.error(
                `Error on job ${JSON.stringify(payload.data)}: ${e.message}`,
                e.stack
            );

            throw e;
        }
    }

    async process({ data }: Job<BlockchainAction>): Promise<unknown> {
        switch (data.type) {
            case BlockchainActionType.Issuance:
                const issuanceParams = data.payload;
                this.logger.debug(`Triggering issuance for: ${JSON.stringify(issuanceParams)}`);

                const issuanceTx = await this.commandBus.execute(
                    new IssueCertificateCommand(
                        issuanceParams.toAddress,
                        issuanceParams.energyValue,
                        issuanceParams.fromTime,
                        issuanceParams.toTime,
                        issuanceParams.deviceId,
                        issuanceParams.userId,
                        false,
                        JSON.stringify(issuanceParams.metadata)
                    )
                );

                const issuanceCertificates = await this.transactionPoll.waitForNewCertificates(
                    issuanceTx.hash
                );

                return issuanceCertificates[0];

            case BlockchainActionType.Transfer:
                const transferParams = data.payload;
                this.logger.debug(`Triggering transfer for: ${JSON.stringify(transferParams)}`);

                return await this.commandBus.execute(
                    new TransferCertificateCommand(
                        transferParams.certificateId,
                        transferParams.fromAddress,
                        transferParams.toAddress,
                        transferParams.energyValue ? transferParams.energyValue : undefined
                    )
                );

            case BlockchainActionType.Claim:
                const claimParams = data.payload;
                this.logger.debug(`Triggering claim for: ${JSON.stringify(claimParams)}`);

                return await this.commandBus.execute(
                    new ClaimCertificateCommand(
                        claimParams.certificateId,
                        claimParams.claimData,
                        claimParams.forAddress,
                        claimParams.energyValue ? claimParams.energyValue.toString() : undefined
                    )
                );

            case BlockchainActionType.BatchIssuance:
                const batchIssuanceParams = data.payload;
                this.logger.debug(
                    `Triggering batch issuance for: ${JSON.stringify(batchIssuanceParams)}`
                );

                const batchIssuanceTx = await this.commandBus.execute(
                    new BatchIssueCertificatesCommand(
                        batchIssuanceParams.certificates.map((certificate) => ({
                            to: certificate.toAddress,
                            deviceId: certificate.deviceId,
                            energy: certificate.energyValue,
                            fromTime: certificate.fromTime,
                            toTime: certificate.toTime,
                            metadata: JSON.stringify(certificate.metadata)
                        }))
                    )
                );

                /**
                 * @BUG
                 *
                 * Original certificate order is lost here
                 */
                const batchIssuanceCertificates = await this.transactionPoll.waitForNewCertificates(
                    batchIssuanceTx.hash
                );

                return batchIssuanceCertificates.map((c) => c.id);

            case BlockchainActionType.BatchTransfer:
                const batchTransferParams = data.payload;
                this.logger.debug(
                    `Triggering batch transfer for: ${JSON.stringify(batchTransferParams)}`
                );

                return await this.commandBus.execute(
                    new BatchTransferCertificatesCommand(
                        batchTransferParams.transfers.map((t) => ({
                            id: t.certificateId,
                            to: t.toAddress,
                            from: t.fromAddress,
                            amount: t.energyValue ? BigNumber.from(t.energyValue) : undefined
                        }))
                    )
                );

            case BlockchainActionType.BatchClaim:
                const batchClaimParams = data.payload;
                this.logger.debug(
                    `Triggering batch claim for: ${JSON.stringify(batchClaimParams)}`
                );

                return await this.commandBus.execute(
                    new BatchClaimCertificatesCommand(
                        batchClaimParams.claims.map((c) => ({
                            id: c.certificateId,
                            from: c.forAddress,
                            amount: c.energyValue ? BigNumber.from(c.energyValue) : undefined,
                            claimData: c.claimData
                        }))
                    )
                );
        }
    }
}
