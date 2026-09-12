export type CallDestinationType = 'saved_contact' | 'business' | 'one_time_number';
export type CallGoal =
  | 'business_information'
  | 'reservation_request'
  | 'appointment_availability'
  | 'quote_request'
  | 'availability_check'
  | 'relay_message'
  | 'custom_information_request';

export interface ThirdPartyCallDraft {
  contactId?: string;
  destinationType: CallDestinationType;
  destinationPhone: string;
  destinationDisplayName: string;
  goal: CallGoal;
  purpose: string;
  userInstructions: string;
  approvedScript: string;
  openingDisclosure: string;
  allowedActions: string[];
  maximumDurationSeconds: number;
  maximumCreditReservation: number;
}

export interface JarvisContactDraft {
  displayName: string;
  phone: string;
  destinationType: 'saved_contact' | 'business';
  relationship?: string;
  notes?: string;
  profileImageUrl?: string;
  allowAiCalls: true;
  allowAiMessages: boolean;
  consentStatus: 'user_asserted';
}

export interface JarvisContact {
  id: string;
  displayName: string;
  destinationType: 'saved_contact' | 'business';
  destinationMasked: string;
  relationship?: string | null;
  notes?: string | null;
  profileImageUrl?: string | null;
}

export interface ThirdPartyCallJob {
  id: string;
  status: string;
  destinationType?: CallDestinationType;
  destinationDisplayName?: string;
  destinationMasked?: string;
  goal?: CallGoal;
  purpose?: string;
  approvedScript?: string;
  openingDisclosure?: string;
  allowedActions?: string[];
  maximumDurationSeconds?: number;
  maximumCreditReservation?: number;
  reservedCredits?: number;
  settledCredits?: number;
  providerStatus?: string | null;
  resultSummary?: string | null;
  failureReason?: string | null;
  pendingActionSummary?: string | null;
  pendingActionDecision?: 'approved' | 'declined' | null;
  createdAt?: string;
}
