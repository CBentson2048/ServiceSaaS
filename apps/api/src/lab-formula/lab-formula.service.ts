import { Injectable } from '@nestjs/common';
import { createFormulaDraft, type FormulaDraft } from '@sheer/lab-core';
import type { AddFormulaItemDto, CaptureWeightDto, SaveFormulaDto, StartFormulaDto } from './dto';

@Injectable()
export class LabFormulaService {
  start(dto: StartFormulaDto): FormulaDraft {
    return createFormulaDraft({
      id: 'formula_scaffold',
      labSessionId: dto.labSessionId,
      appointmentId: dto.appointmentId,
      clientProfileId: dto.clientProfileId,
    });
  }

  get(id: string): FormulaDraft {
    return createFormulaDraft({
      id,
      labSessionId: 'lab_session_scaffold',
    });
  }

  addItem(id: string, dto: AddFormulaItemDto) {
    // TODO: append formula item with product validation and local inventory cost snapshot.
    return {
      formulaId: id,
      item: {
        id: 'formula_item_scaffold',
        productId: dto.productId,
        productName: dto.productName,
        targetGrams: dto.targetGrams,
        entryMode: 'manual',
      },
    };
  }

  captureWeight(id: string, dto: CaptureWeightDto) {
    // TODO: validate active session/device, capture BLE/manual audit metadata, and buffer if offline.
    return {
      formulaId: id,
      capturedGrams: dto.grams,
      source: dto.source ?? 'ble_scale',
    };
  }

  finishMixing(id: string) {
    return { formulaId: id, status: 'ready_for_review' };
  }

  save(id: string, dto: SaveFormulaDto) {
    // TODO: final save must be transactional: formula, items, inventory deductions, billing handoff, audit.
    return {
      formulaId: id,
      labSessionId: dto.labSessionId,
      status: 'saved',
      billingHandoffRequested: dto.billingHandoffRequested,
    };
  }

  recalculate(id: string) {
    // TODO: recalculate charge preview from product usage and location billing rules.
    return { formulaId: id, chargePreviewCents: 4250, currencyCode: 'GBP' };
  }

  duplicate(id: string) {
    // TODO: duplicate formula as a new draft while preserving source formula reference.
    return { sourceFormulaId: id, duplicatedFormulaId: 'formula_duplicate_scaffold' };
  }
}
