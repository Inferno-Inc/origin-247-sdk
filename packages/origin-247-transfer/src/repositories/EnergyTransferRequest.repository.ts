import { EnergyTransferRequest } from '../EnergyTransferRequest';

export interface ICreateNewCommand {
    buyerAddress: string;
    sellerAddress: string;
    volume: string;
    generatorId: string;
}

export const ENERGY_TRANSFER_REQUEST_REPOSITORY = Symbol.for('ENERGY_TRANSFER_REQUEST_REPOSITORY');

export interface EnergyTransferRequestRepository {
    createNew(command: ICreateNewCommand): Promise<EnergyTransferRequest>;
    findByCertificateId(certificateId: number): Promise<EnergyTransferRequest | null>;
    findById(id: number): Promise<EnergyTransferRequest | null>;
    save(entity: EnergyTransferRequest): Promise<void>;
    updateWithLock(id: number, cb: (entity: EnergyTransferRequest) => void): Promise<void>;
}
